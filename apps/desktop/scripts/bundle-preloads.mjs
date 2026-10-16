// Sandboxed preloads can only `require("electron")`, so each one is bundled into a single CommonJS file
// (with `@defe2end/recorder/dom` and anything else it imports). Runs after `tsc`, overwriting its output.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = ["preload.ts", "recorder-preload.ts", "hud-preload.ts", "find-preload.ts"].map((f) => path.join(root, "src", f)).filter(existsSync);

await build({
  entryPoints: entries,
  outdir: path.join(root, "dist"),
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "chrome140",
  external: ["electron"],
  sourcemap: true,
  logLevel: "warning",
});
