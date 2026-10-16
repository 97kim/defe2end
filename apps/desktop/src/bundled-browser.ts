// The packaged app runs the Chromium (and video ffmpeg) shipped in `Resources/browsers`, fetched at
// build time by scripts/fetch-browsers.mjs for the runner's Playwright version. A development run uses
// Playwright's own cache. Imported first by main.ts: Playwright reads PLAYWRIGHT_BROWSERS_PATH when it loads.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

const bundledDir = app.isPackaged ? path.join(process.resourcesPath, "browsers") : null;
if (bundledDir && existsSync(bundledDir)) process.env.PLAYWRIGHT_BROWSERS_PATH = bundledDir;

/** Chromium executable inside each `browsers/chromium-*` build (Playwright's layout). */
const EXECUTABLES: Record<string, string[]> = {
  darwin: ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
  win32: ["chrome.exe"],
  linux: ["chrome"],
};

/** The bundled Chromium (`browsers/chromium-*\/chrome-*\/…`), used visible or headless; undefined in development. */
export function bundledBrowserPath(): string | undefined {
  if (!bundledDir || !existsSync(bundledDir)) return undefined;
  const exe = EXECUTABLES[process.platform];
  if (!exe) return undefined;
  for (const build of readdirSync(bundledDir).filter((d) => /^chromium-\d+$/.test(d))) {
    for (const dir of readdirSync(path.join(bundledDir, build)).filter((d) => d.startsWith("chrome-"))) {
      const candidate = path.join(bundledDir, build, dir, ...exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
