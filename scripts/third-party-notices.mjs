#!/usr/bin/env node
// Builds the third-party notices of one release artifact from its CycloneDX SBOM (stage 8 contract section 3).
// License, notice and copyright files are copied verbatim from where each component sits in the scanned tree:
// npm packages from their package directory, OS packages from /usr/share/doc/<name>/copyright. Bundled files
// the scanner can't see as packages (Electron, Chromium, ffmpeg) come in with --extra and are added to the SBOM
// too. Components under licenses that oblige the distributor to offer source (GPL, LGPL, MPL, EPL) are listed
// in their own section.
//
//   node scripts/third-party-notices.mjs --sbom sbom.cdx.json --root <scanned dir> --out NOTICES.txt \
//     [--sbom-out merged.cdx.json] [--extra "name@version=license-id=path"]... [--title "defE2End web image"]
// <path> of an --extra is a license file or a directory whose license-like files are taken (one level deep).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|authors|third[-_]party|licenses?\.chromium)([.\-_].*)?$/i;
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

/** "a@1=MIT=/x" → { name: "a", version: "1", license: "MIT", path: "/x" } (a scoped name keeps its @). */
export function parseExtra(spec) {
  const m = /^(@?[^@=]+)@([^=]+)=([^=]+)=(.+)$/.exec(spec);
  if (!m) throw new Error(`bad --extra ${JSON.stringify(spec)} (expected name@version=license=path)`);
  return { name: m[1], version: m[2], license: m[3], path: m[4] };
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

export function buildNotices({ sbom, root, extras = [], title = "defE2End" }) {
  const components = [...(sbom.components ?? [])];
  for (const e of extras) {
    components.push({
      type: "library",
      name: e.name,
      version: e.version,
      licenses: [{ expression: e.license }],
      properties: [{ name: "defe2end:bundled", value: "true" }],
      _licensePath: e.path,
    });
  }
  components.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));

  // Identical texts (dozens of MIT copies with the same wording) are printed once and referenced.
  const texts = new Map();
  const entries = [];
  const missing = [];
  const sourceOffer = [];
  for (const c of components) {
    const ids = licenseIds(c);
    const files = licenseFiles(licenseDir(c, root));
    const refs = files.map((file) => {
      const body = readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim();
      const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
      if (!texts.has(hash)) texts.set(hash, body);
      return hash;
    });
    if (!refs.length) missing.push(c);
    if (ids.some((id) => SOURCE_OFFER.test(id))) sourceOffer.push(c);
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
  lines.push("", "== Source code offer", "");
  if (sourceOffer.length) {
    lines.push(
      "The components below are under licenses that require their source code to be available. defE2End does",
      "not modify them. Their source is available from each project's upstream release of the listed version,",
      "and the defE2End maintainers provide it on request through the project's issue tracker for at least three",
      "years after this release.",
      "",
    );
    for (const c of sourceOffer) lines.push(`${label(c)}  [${licenseIds(c).join(", ")}]`);
  } else lines.push("None.");
  lines.push("", "== License texts", "");
  for (const [hash, body] of texts) lines.push(`---- ${hash}`, "", body, "");
  return { text: `${lines.join("\n")}\n`, components, missing, sourceOffer };
}

export function mergedSbom(sbom, components) {
  const clean = components.map(({ _licensePath, ...c }) => c);
  return { ...sbom, components: clean };
}

function args(argv) {
  const out = { extra: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key === "extra") out.extra.push(argv[i + 1]);
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
  const result = buildNotices({ sbom, root: a.root, extras, title: a.title });
  writeFileSync(a.out, result.text);
  if (a["sbom-out"]) writeFileSync(a["sbom-out"], `${JSON.stringify(mergedSbom(sbom, result.components), null, 2)}\n`);
  console.log(`${result.components.length} components, ${result.missing.length} without license text, ${result.sourceOffer.length} with a source offer`);
}
