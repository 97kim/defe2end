import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The variable table in docs/guide/configuration.md must list exactly the variables the server code and the
// example compose file read.
const root = resolve(import.meta.dirname, "../../..");
const codeDirs = ["apps/web", "apps/worker", "packages/db", "packages/shared"];
const skipDirs = new Set(["node_modules", "dist", ".next", "test", "tests", "e2e", "scripts", "turbo"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return skipDirs.has(name) || name.startsWith(".next") ? [] : sourceFiles(path);
    return /\.(ts|tsx|mjs|cjs|js)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

function codeVariables(): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /\benv\.([A-Z][A-Z0-9_]+)/g,
    /\benv\[["']([A-Z][A-Z0-9_]+)["']\]/g,
    /\b(?:int|bool)\(env, "([A-Z][A-Z0-9_]+)"/g,
  ];
  for (const file of codeDirs.flatMap((d) => sourceFiles(join(root, d)))) {
    const text = readFileSync(file, "utf8");
    for (const re of patterns) for (const m of text.matchAll(re)) names.add(m[1]!);
  }
  return names;
}

function composeVariables(): Set<string> {
  const text = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  return new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!));
}

function documentedVariables(): Set<string> {
  const text = readFileSync(join(root, "docs/guide/configuration.md"), "utf8");
  return new Set([...text.matchAll(/^\| `([A-Za-z_][A-Za-z0-9_]*)` \|/gm)].map((m) => m[1]!));
}

describe("configuration guide", () => {
  it("lists every variable the code and compose file read, and nothing else", () => {
    const used = new Set([...codeVariables(), ...composeVariables()]);
    const documented = documentedVariables();
    expect([...used].filter((n) => !documented.has(n)).sort(), "read but not documented").toEqual([]);
    expect([...documented].filter((n) => !used.has(n)).sort(), "documented but never read").toEqual([]);
  });
});
