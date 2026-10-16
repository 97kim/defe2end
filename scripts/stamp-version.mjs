#!/usr/bin/env node
// Writes the release version into the build tree so the app, server, runner and MCP all report it
// (stage 8 contract section 3). Run in a release build before `pnpm build` and the image builds; the changes
// are build output, never committed.
// Usage: node scripts/stamp-version.mjs v1.2.3[-rc.N]   (defaults to $GITHUB_REF_NAME)
//        node scripts/stamp-version.mjs --check v1.2.3  (only parse and print, change nothing)
// Prints the version; under GitHub Actions also sets the outputs version, minor (X.Y) and prerelease.
import { appendFileSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;
const STAMPED_KEYS = ["server", "desktop", "runner", "mcp"];

/** `v1.2.3-rc.4` → { version: "1.2.3-rc.4", minor: "1.2", prerelease: true }; anything else throws. */
export function parseTag(tag) {
  const m = TAG.exec(tag ?? "");
  if (!m) throw new Error(`not a release tag: ${JSON.stringify(tag)} (expected vX.Y.Z or vX.Y.Z-rc.N)`);
  return { version: tag.slice(1), minor: `${Number(m[1])}.${Number(m[2])}`, prerelease: m[4] !== undefined };
}

/** Replaces the product versions in packages/shared/src/version.ts; the step format number stays. */
export function stampVersionsSource(source, version) {
  let out = source;
  for (const key of STAMPED_KEYS) {
    const re = new RegExp(`^(\\s*${key}: )"[^"]*",$`, "m");
    if (!re.test(out)) throw new Error(`version.ts: no "${key}" entry`);
    out = out.replace(re, `$1"${version}",`);
  }
  return out;
}

function workspacePackages() {
  const files = [];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      const file = join(ROOT, group, entry.name, "package.json");
      if (entry.isDirectory() && existsSync(file)) files.push(file);
    }
  }
  return files;
}

export function stamp(version) {
  for (const file of workspacePackages()) {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    pkg.version = version;
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  const source = join(ROOT, "packages/shared/src/version.ts");
  writeFileSync(source, stampVersionsSource(readFileSync(source, "utf8"), version));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const check = args[0] === "--check";
  const tag = (check ? args[1] : args[0]) ?? process.env.GITHUB_REF_NAME;
  let parsed;
  try {
    parsed = parseTag(tag);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!check) stamp(parsed.version);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${parsed.version}\nminor=${parsed.minor}\nprerelease=${parsed.prerelease}\n`);
  }
  console.log(parsed.version);
}
