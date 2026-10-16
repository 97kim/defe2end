// Downloads the Chromium (and ffmpeg for video) of the runner's Playwright version, once per target, into
// `browsers/{os}-{arch}` for electron-builder's `extraResources`. One full Chromium serves both modes: a
// visible window by default and headless when the app's "hide the browser" setting is on (contract 4.4.1).
// Usage: node scripts/fetch-browsers.mjs [mac-arm64 mac-x64 win-x64]   (default: this OS's package targets)
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Resolve playwright-core through the runner so the browser matches the version that launches it.
const runnerRequire = createRequire(createRequire(path.join(root, "package.json")).resolve("@defe2end/runner"));
const playwrightRequire = createRequire(runnerRequire.resolve("playwright/package.json"));
const cli = path.join(path.dirname(playwrightRequire.resolve("playwright-core/package.json")), "cli.js");
const coreDir = path.dirname(playwrightRequire.resolve("playwright-core/package.json"));
const revision = JSON.parse(readFileSync(path.join(coreDir, "browsers.json"), "utf8")).browsers.find((b) => b.name === "chromium").revision;
console.log(`playwright-core ${playwrightRequire("playwright-core/package.json").version}, chromium ${revision}`);

/** Playwright's host platform names (`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE`) for each package target. */
const PLATFORMS = { "mac-arm64": "mac15-arm64", "mac-x64": "mac15", "win-x64": "win64" };
const defaults = process.platform === "darwin" ? ["mac-arm64", "mac-x64"] : process.platform === "win32" ? ["win-x64"] : [];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : defaults;

for (const target of targets) {
  const hostPlatform = PLATFORMS[target];
  if (!hostPlatform) throw new Error(`Unknown target ${target} (expected ${Object.keys(PLATFORMS).join(", ")})`);
  const dir = path.join(root, "browsers", target);
  mkdirSync(dir, { recursive: true });
  execFileSync(process.execPath, [cli, "install", "chromium", "ffmpeg", "--no-shell"], {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: hostPlatform, PLAYWRIGHT_SKIP_BROWSER_GC: "1" },
  });
  // A Chromium left from an older Playwright, or a headless shell from before 4.4.1, would ship too.
  for (const old of readdirSync(dir).filter((d) => d.startsWith("chromium_headless_shell-") || (d.startsWith("chromium-") && d !== `chromium-${revision}`))) rmSync(path.join(dir, old), { recursive: true, force: true });
  if (!existsSync(path.join(dir, `chromium-${revision}`))) throw new Error(`No chromium-${revision} in ${dir}`);
  console.log(`${target}: ${readdirSync(dir).join(", ")}`);
}
