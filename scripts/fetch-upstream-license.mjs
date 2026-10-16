#!/usr/bin/env node
// Copies the license text of a package version that ships without one from its upstream repository into
// scripts/licenses/<name, / as __>@<version>.txt, where scripts/third-party-notices.mjs picks it up. Run by hand
// when the notices report a component without license text; review the result before committing it.
// The first line records where the text came from.
//   node scripts/fetch-upstream-license.mjs <name>@<version> [repository-url-override]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NAMES = ["LICENSE", "UNLICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "license", "license.md", "LICENSE-MIT", "MIT-LICENSE", "COPYING"];

const spec = process.argv[2] ?? "";
const at = spec.lastIndexOf("@");
const name = spec.slice(0, at);
const version = spec.slice(at + 1);
if (at <= 0 || !version) {
  console.error("usage: fetch-upstream-license.mjs <name>@<version> [repository-url]");
  process.exit(2);
}
const meta = await (await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`)).json().catch(() => ({}));
const repo = process.argv[3] ?? (typeof meta.repository === "string" ? meta.repository : meta.repository?.url);
const dir = typeof meta.repository === "object" ? meta.repository.directory : undefined;
const m = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:[/#].*)?$/.exec(repo ?? "");
if (!m) {
  console.error(`${spec}: no repository found (license field: ${meta.license ?? "none"})`);
  process.exit(1);
}
// The default branch (HEAD) is the last resort, for versions published without the file; the Source line says so.
const refs = [meta.gitHead, `v${version}`, version, `${name}@${version}`, "HEAD"].filter(Boolean);
for (const ref of refs) {
  for (const base of [dir, ""].filter((d) => d !== undefined)) {
    for (const file of NAMES) {
      const url = `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${encodeURIComponent(ref)}/${base ? `${base}/` : ""}${file}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const out = fileURLToPath(new URL(`licenses/${name.replaceAll("/", "__")}@${version}.txt`, import.meta.url));
      writeFileSync(out, `Source: ${url}\n\n${(await res.text()).trim()}\n`);
      console.log(`${spec}: ${url} (license field: ${meta.license ?? "none"})`);
      process.exit(0);
    }
  }
}
console.error(`${spec}: no license file in ${repo} at ${refs.join(", ")} (license field: ${meta.license ?? "none"})`);
process.exit(1);
