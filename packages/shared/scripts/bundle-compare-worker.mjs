// Bundles the image comparison worker into one CommonJS file with pixelmatch and pngjs inside
// (`dist/visual-compare-worker.cjs`). The desktop app ships it outside its archive and the web server's
// standalone output includes it; both pass its path to `setVisualCompareWorkerFile`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "src", "server", "visual-compare-worker.ts")],
  outfile: path.join(root, "dist", "visual-compare-worker.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  logLevel: "warning",
});
