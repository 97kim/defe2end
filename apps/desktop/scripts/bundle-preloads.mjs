// Sandboxed preloads can only `require("electron")`, so each one is bundled into a single CommonJS file
// (with `@defe2end/recorder/dom` and anything else it imports). Runs after `tsc`, overwriting its output.
import { copyFileSync, existsSync } from "node:fs";
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

// The image comparison worker (one file with its dependencies). electron-builder unpacks it from the archive
// (`asarUnpack`) and main.ts passes its path to `setVisualCompareWorkerFile`.
copyFileSync(fileURLToPath(import.meta.resolve("@defe2end/shared/visual-compare-worker.cjs")), path.join(root, "dist", "visual-compare-worker.cjs"));
