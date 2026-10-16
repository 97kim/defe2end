#!/usr/bin/env node
// Fails if a local env file (anything named .env* except .env.example) would be sent into a Docker build.
// Every Dockerfile builds from the repo root with its own `<Dockerfile>.dockerignore`; each one is checked
// against the env files on disk now plus typical ones a developer may create later.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".turbo", "dist"]);
const TYPICAL = [".env", ".env.local", ".env.production", ".env.production.local", ".env.development"].flatMap((name) =>
  ["", "apps/web/", "apps/worker/", "packages/db/", "deploy/"].map((dir) => dir + name),
);

function walk(dir, out = { dockerfiles: [], envFiles: [] }) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path, out);
    } else if (/^Dockerfile(\..+)?$/.test(entry.name) && !entry.name.endsWith(".dockerignore")) {
      out.dockerfiles.push(relative(ROOT, path));
    } else if (entry.name.startsWith(".env")) {
      out.envFiles.push(relative(ROOT, path));
    }
  }
  return out;
}

/** dockerignore pattern -> RegExp over a slash-separated path relative to the context root. */
function toRegExp(pattern) {
  let src = "";
  const p = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        src += "(?:.*/)?";
        i += 2;
      } else {
        src += ".*";
        i += 1;
      }
    } else if (c === "*") src += "[^/]*";
    else if (c === "?") src += "[^/]";
    else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`);
}

function parseDockerignore(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => (l.startsWith("!") ? { negate: true, re: toRegExp(l.slice(1)) } : { negate: false, re: toRegExp(l) }));
}

/** Last matching rule wins; a rule matching a parent directory covers everything under it. */
function isExcluded(rules, path) {
  const parts = path.split("/");
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  let excluded = false;
  for (const rule of rules) if (candidates.some((c) => rule.re.test(c))) excluded = !rule.negate;
  return excluded;
}

function leakedEnvFiles(rules, paths) {
  return paths.filter((p) => !/(^|\/)\.env\.example$/.test(p) && !isExcluded(rules, p));
}

const { dockerfiles, envFiles } = walk(ROOT);
const problems = [];
for (const dockerfile of dockerfiles) {
  let text;
  try {
    text = readFileSync(join(ROOT, `${dockerfile}.dockerignore`), "utf8");
  } catch {
    problems.push(`${dockerfile}: no ${dockerfile}.dockerignore (the whole repo, env files included, would be the build context)`);
    continue;
  }
  const rules = parseDockerignore(text);
  for (const leak of leakedEnvFiles(rules, [...new Set([...envFiles, ...TYPICAL])])) problems.push(`${dockerfile}: ${leak} would be in the build context`);
  if (isExcluded(rules, "deploy/.env.example")) problems.push(`${dockerfile}: .env.example should stay in the build context`);
}
if (dockerfiles.length === 0) problems.push("no Dockerfile found; the check has rotted");

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`docker context: ${dockerfiles.length} Dockerfiles keep local env files out.`);
