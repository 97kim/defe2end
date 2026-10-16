// Entry of the bundled comparison worker (`dist/visual-compare-worker.cjs`, scripts/bundle-compare-worker.mjs):
// one file with its dependencies, so a packaged app or a bundled web server can start it from a known path.
import { parentPort, workerData } from "node:worker_threads";
import { compareImagesSync } from "./visual-compare-core.js";

const { a, b, opts } = workerData as { a: Uint8Array; b: Uint8Array; opts: Parameters<typeof compareImagesSync>[2] };
try {
  const result = compareImagesSync(a, b, opts);
  parentPort!.postMessage({ result }, result.diffPng ? [result.diffPng.buffer as ArrayBuffer] : []);
} catch (err) {
  parentPort!.postMessage({ error: String((err as Error)?.stack ?? err) });
}
