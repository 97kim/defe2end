// `defe2end-mcp` (stage 6 contract section 2) ships inside the app: `apps/mcp/src/cli.ts` bundled into one
// ESM file (the entry uses top-level await) that the app's own executable runs with `ELECTRON_RUN_AS_NODE=1`. Packaged as `resources/mcp/defe2end-mcp.mjs`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "..", "mcp", "src", "cli.ts")],
  outfile: path.join(root, "dist", "mcp", "defe2end-mcp.mjs"),
  bundle: true,
  format: "esm",
  // Bundled CommonJS dependencies may still call `require`.
  banner: { js: "import { createRequire as __defe2endCreateRequire } from \"node:module\"; const require = __defe2endCreateRequire(import.meta.url);" },
  platform: "node",
  target: "node22",
  logLevel: "warning",
});
