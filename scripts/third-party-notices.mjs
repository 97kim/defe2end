#!/usr/bin/env node
// Builds the third-party notices of one release artifact from its CycloneDX SBOM (stage 8 contract section 3).
// License, notice and copyright files are copied verbatim from where each component sits in the scanned tree:
// npm packages from their package directory, OS packages from /usr/share/doc/<name>/copyright. Bundled files
// the scanner can't see as packages (Electron, Chromium, ffmpeg) come in with --extra and are added to the SBOM
// too. Components under licenses that oblige the distributor to make source available (GPL, LGPL, MPL, EPL)
// are listed with where their original source is: the base distribution's source package and exact version
// for OS packages, the package's source archive or repository and version for npm and Go, the given address
// for bundled files.
// A component without any license text fails the run, unless scripts/license-exceptions.json lists it (name,
// optional version prefix, and the reason it was reviewed and accepted).
//
//   node scripts/third-party-notices.mjs --sbom sbom.cdx.json --root <scanned dir> --out NOTICES.txt \
//     [--sbom-out merged.cdx.json] [--extra "name@version=license-id=path=source-url"]... [--title "..."]
//     [--extra-note "name@version=how it was built"]... [--exceptions scripts/license-exceptions.json] [--texts-root <build-stage tree with the full node_modules>]
// <path> of an --extra is a license file or a directory whose license-like files are taken (one level deep).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LICENSE_FILE = /^((licen[cs]e|copying|notice|copyright|authors|third[-_]party|licenses?\.chromium)([.\-_].*)?|(mit|apache|bsd|isc)[-_.]licen[cs]e(\..*)?|unlicen[cs]e(\..*)?)$/i;
/** Upstream texts for packages that ship none (scripts/licenses/<name, / as __>@<version>.txt, with their source). */
const UPSTREAM_DIR = fileURLToPath(new URL("licenses/", import.meta.url));
const SOURCE_OFFER = /\b(A?GPL|LGPL|MPL|EPL|CDDL)\b/i;

export function licenseFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  if (statSync(dir).isFile()) return [dir];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && LICENSE_FILE.test(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

/**
 * The license section of a package README (a "License" / "Copyright and Licensing" heading up to the next heading
 * of the same or a higher level), for packages that keep their license there instead of in a file.
 */
export function readmeLicenseSection(dir) {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  const readme = readdirSync(dir).find((f) => /^readme(\.(md|markdown|txt))?$/i.test(f));
  if (!readme) return undefined;
  const lines = readFileSync(join(dir, readme), "utf8").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s*(licen[cs]e|licensing|copyright( and licen[cs]ing)?)\s*$/i.test(l.trim()));
  if (start < 0) return undefined;
  const level = /^#+/.exec(lines[start].trim())[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i].trim());
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end).join("\n").trim();
  return section.split("\n").length > 1 ? `From ${readme}:\n\n${section}` : undefined;
}

/** "a@1=MIT=/x=https://src" → { name: "a", version: "1", license: "MIT", path: "/x", source } (a scoped name keeps its @). */
export function parseExtra(spec) {
  const m = /^(@?[^@=]+)@([^=]+)=([^=]+)=([^=]+)=(https:\/\/\S+)$/.exec(spec);
  if (!m) throw new Error(`bad --extra ${JSON.stringify(spec)} (expected name@version=license=path=https-source-url)`);
  return { name: m[1], version: m[2], license: m[3], path: m[4], source: m[5] };
}

/** Where the original source of a component is, from its SBOM entry. */
export function sourceLocation(component, distro) {
  if (component._source) return `${component._source} (version ${component.version})${component._note ? `\n    ${component._note}` : ""}`;
  const purl = component.purl ?? "";
  if (purl.startsWith("pkg:deb/")) {
    const src = property(component, "syft:metadata:source") || component.name;
    const ver = property(component, "syft:metadata:sourceVersion") || component.version;
    return `${distro ?? "base distribution"} source package ${src} ${ver}${distro?.startsWith("debian") ? ` — https://sources.debian.org/src/${src}/${ver}/` : ""}`;
  }
  const vcs = component.externalReferences?.find((r) => r.type === "vcs" || r.type === "distribution")?.url?.replace(/^git\+/, "");
  if (purl.startsWith("pkg:npm/")) {
    const base = component.name.replace(/^@[^/]+\//, "");
    return `${vcs ? `${vcs} at version ${component.version}; ` : ""}source archive https://registry.npmjs.org/${component.name}/-/${base}-${component.version}.tgz`;
  }
  if (purl.startsWith("pkg:golang/")) return `https://${component.name} at ${component.version}`;
  return vcs ? `${vcs} at ${component.version}` : `unknown — ${component.name} ${component.version}`;
}

/**
 * Reviewed components that ship no license text anywhere: [{ name, version, license, holder, reason }]. Matched on
 * the exact name and version (a package vendored in Next: "bundled in next <Next version>").
 */
export function findException(component, exceptions) {
  return exceptions.find((e) => e.name === component.name && e.version === component.version && e.license && e.holder && typeof e.reason === "string" && e.reason.trim());
}

/** The SPDX standard text of the declared license (scripts/licenses/spdx/<id>.txt) with the copyright holder filled in. */
export function standardText(exception, spdxDir = join(UPSTREAM_DIR, "spdx")) {
  const file = join(spdxDir, `${exception.license}.txt`);
  if (!existsSync(file)) throw new Error(`no SPDX text for ${exception.license} (${file}) needed by ${exception.name}`);
  const body = readFileSync(file, "utf8").replace(/^Source: .*\n\n?/, "").trim();
  const placeholder = /<year> <(copyright holders|owner)>/;
  const filled = placeholder.test(body) ? body.replace(placeholder, exception.holder) : `Copyright ${exception.holder}\n\n${body}`;
  return `${exception.name} ${exception.version}: the package carries no license text; its declared ${exception.license} license, standard text:\n\n${filled}`;
}

export function licenseIds(component) {
  return (component.licenses ?? []).map((l) => l.license?.id ?? l.license?.name ?? l.expression).filter(Boolean);
}

function property(component, name) {
  return component.properties?.find((p) => p.name === name)?.value;
}

/** Where a component's license files are, relative to the scanned root. */
export function licenseDir(component, root) {
  if (component._licensePath) return component._licensePath;
  const purl = component.purl ?? "";
  if (purl.startsWith("pkg:deb/")) return join(root, "usr/share/doc", component.name, "copyright");
  const location = property(component, "syft:location:0:path");
  if (location) return join(root, location.replace(/\/[^/]+$/, ""));
  return undefined;
}

/**
 * The same package directory in another tree laid out by pnpm (`node_modules/.pnpm/<id>/node_modules/<name>`),
 * e.g. the build stage of an image whose final stage keeps only traced files and drops license texts.
 */
export function textsRootDir(component, textsRoot) {
  const location = property(component, "syft:location:0:path");
  const i = location?.indexOf("/node_modules/.pnpm/") ?? -1;
  if (!textsRoot || i < 0) return undefined;
  return join(textsRoot, location.slice(i + 1).replace(/\/[^/]+$/, ""));
}

/** Packages vendored inside Next (`next/dist/compiled/*`) carry no version of their own: show Next's. */
export function displayVersion(component) {
  if (component.version && component.version !== "UNKNOWN") return component.version;
  const m = /\/\.pnpm\/next@([0-9][^_/(]*)[^/]*\/node_modules\/next\/dist\/compiled\//.exec(property(component, "syft:location:0:path") ?? "");
  return m ? `bundled in next ${m[1]}` : component.version;
}

export function buildNotices({ sbom, root, extras = [], title = "defE2End", exceptions = [], textsRoot, notes = {} }) {
  const os = (sbom.components ?? []).find((c) => c.type === "operating-system");
  const distro = os ? `${os.name} ${os.version ?? ""}`.trim() : undefined;
  const components = [...(sbom.components ?? [])];
  for (const e of extras) {
    components.push({
      type: "library",
      name: e.name,
      version: e.version,
      licenses: [{ expression: e.license }],
      properties: [{ name: "defe2end:bundled", value: "true" }],
      _licensePath: e.path,
      _source: e.source,
      _note: notes[`${e.name}@${e.version}`],
    });
  }
  components.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));

  // Identical texts (dozens of MIT copies with the same wording) are printed once and referenced.
  const texts = new Map();
  const entries = [];
  const missing = [];
  const sourceOffer = [];
  for (const c of components) {
    // Plain file entries (digests of every file) and the OS record stay in the SBOM; defE2End's own packages
    // are covered by its own license and NOTICE.
    if (c.type === "file" || c.type === "operating-system" || c.name?.startsWith("@defe2end/")) continue;
    const ids = licenseIds(c);
    if (c.type === "library" && c.version === "UNKNOWN") c.version = displayVersion(c);
    let files = licenseFiles(licenseDir(c, root));
    if (!files.length) files = licenseFiles(textsRootDir(c, textsRoot));
    if (!files.length) files = licenseFiles(join(UPSTREAM_DIR, `${String(c.name).replaceAll("/", "__")}@${c.version}.txt`));
    const bodies = files.map((file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim());
    if (!bodies.length) {
      const section = readmeLicenseSection(licenseDir(c, root)) ?? readmeLicenseSection(textsRootDir(c, textsRoot));
      if (section) bodies.push(section);
    }
    // An exception adds the standard text where the package states its license without the full text.
    const exception = findException(c, exceptions) && !files.length ? findException(c, exceptions) : undefined;
    if (exception) bodies.push(standardText(exception));
    const refs = bodies.map((body) => {
      const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
      if (!texts.has(hash)) texts.set(hash, body);
      return hash;
    });
    if (!refs.length) missing.push(c);
    // Bundled files are listed with their source whatever the license.
    if (c._source || ids.some((id) => SOURCE_OFFER.test(id))) sourceOffer.push(c);
    entries.push({ c, ids, refs });
  }

  const label = (c) => `${c.name} ${c.version ?? ""}`.trim();
  const lines = [
    `Third-party notices for ${title}`,
    "",
    "This artifact includes the components below. Each keeps its own license; the license, notice and copyright",
    "texts are reproduced as found in the component. A component listed without text carried none in this",
    "artifact; its declared license applies.",
    "",
    "== Components",
    "",
  ];
  for (const { c, ids, refs } of entries) lines.push(`${label(c)}  [${ids.join(", ") || "license not declared"}]${refs.length ? `  text: ${refs.join(", ")}` : ""}`);
  lines.push("", "== Source code", "");
  if (sourceOffer.length) {
    lines.push(
      "The components below are under licenses that require their source code to be available, or ship as",
      "bundled files. They are included unmodified; the corresponding source of each listed version is at:",
      "",
    );
    for (const c of sourceOffer) lines.push(`${label(c)}  [${licenseIds(c).join(", ")}]`, `    ${sourceLocation(c, distro)}`);
  } else lines.push("None.");
  lines.push("", "== License texts", "");
  for (const [hash, body] of texts) lines.push(`---- ${hash}`, "", body, "");
  return { text: `${lines.join("\n")}\n`, components, missing, sourceOffer };
}

export function mergedSbom(sbom, components) {
  const clean = components.map(({ _licensePath, _source, _note, ...c }) => c);
  return { ...sbom, components: clean };
}

function args(argv) {
  const out = { extra: [], notes: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key === "extra") out.extra.push(argv[i + 1]);
    else if (key === "extra-note") out.notes.push(argv[i + 1]);
    else out[key] = argv[i + 1];
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = args(process.argv.slice(2));
  if (!a.sbom || !a.root || !a.out) {
    console.error("usage: third-party-notices.mjs --sbom <file> --root <dir> --out <file> [--sbom-out <file>] [--extra spec]... [--title t]");
    process.exit(2);
  }
  const extras = a.extra.map(parseExtra);
  for (const e of extras) {
    if (!licenseFiles(e.path).length) {
      console.error(`no license text for bundled ${e.name} at ${e.path}`);
      process.exit(1);
    }
  }
  const sbom = JSON.parse(readFileSync(a.sbom, "utf8"));
  const exceptionsFile = a.exceptions ?? fileURLToPath(new URL("license-exceptions.json", import.meta.url));
  const exceptions = existsSync(exceptionsFile) ? JSON.parse(readFileSync(exceptionsFile, "utf8")) : [];
  const result = buildNotices({ sbom, root: a.root, extras, title: a.title, exceptions, textsRoot: a["texts-root"], notes: Object.fromEntries(a.notes.map((n) => [n.slice(0, n.indexOf("=")), n.slice(n.indexOf("=") + 1)])) });
  writeFileSync(a.out, result.text);
  if (a["sbom-out"]) writeFileSync(a["sbom-out"], `${JSON.stringify(mergedSbom(sbom, result.components), null, 2)}\n`);
  console.log(`${result.components.length} components, ${result.sourceOffer.length} with source to make available`);
  if (result.missing.length) {
    console.error(`no license text found for ${result.missing.length} components (review each, then add it with the reason to ${exceptionsFile}):`);
    for (const c of result.missing) console.error(`  ${c.name} ${c.version ?? ""}  ${c.purl ?? ""}`);
    process.exit(1);
  }
}
