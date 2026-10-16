// Build-stage helper for the Docker image: lays out the admin CLI with exactly the packages it needs
// that the Next standalone output doesn't already have. `pg` and `@prisma/client` are left out on purpose:
// the image links them to the copies traced into standalone (see apps/web/Dockerfile).
// Usage: node apps/web/cli/stage.mjs <outDir>
import { cpSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDED_BY_STANDALONE = new Set(["pg", "@prisma/client"]);
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const out = process.argv[2];
if (!out) throw new Error("usage: node apps/web/cli/stage.mjs <outDir>");
const modules = join(out, "node_modules");
const skipFile = (src) => !/\.(d\.ts|d\.mts|d\.cts|map)$/.test(src) && !/\/(README|CHANGELOG)[^/]*$/i.test(src);

mkdirSync(modules, { recursive: true });
cpSync(fileURLToPath(new URL("./defe2end.mjs", import.meta.url)), join(out, "defe2end.mjs"));

// Workspace packages: package.json + built dist only.
for (const name of ["db", "shared"]) {
  const src = join(repo, "packages", name);
  const dest = join(modules, "@defe2end", name);
  mkdirSync(dest, { recursive: true });
  cpSync(join(src, "package.json"), join(dest, "package.json"));
  cpSync(join(src, "dist"), join(dest, "dist"), { recursive: true, filter: skipFile });
}

// Third-party runtime deps of the workspace packages above, followed through pnpm's layout (a package's deps
// sit next to it). Workspace packages themselves are skipped: their dist is copied above.
const copied = new Set();
function copyPackage(name, fromNodeModules) {
  if (PROVIDED_BY_STANDALONE.has(name) || name.startsWith("@types/") || name.startsWith("@defe2end/") || copied.has(name)) return;
  copied.add(name);
  const real = realpathSync(join(fromNodeModules, name));
  cpSync(real, join(modules, name), { recursive: true, dereference: true, filter: skipFile });
  const pkg = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
  const ownNodeModules = name.startsWith("@") ? dirname(dirname(real)) : dirname(real);
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyPackage(dep, ownNodeModules);
}
for (const name of ["db", "shared"]) {
  const pkg = JSON.parse(readFileSync(join(repo, "packages", name, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyPackage(dep, join(repo, "packages", name, "node_modules"));
}

console.log(`admin CLI staged in ${out} with ${[...copied].join(", ")}`);
