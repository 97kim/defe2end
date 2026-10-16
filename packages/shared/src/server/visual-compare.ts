// Runs the image comparison off the calling thread (contract section 3: big images must not hold the event loop).
import { Worker } from "node:worker_threads";
import type { VisualCompareOptions, VisualCompareResult } from "./visual-compare-core.js";

export * from "./visual-compare-core.js";

// Tests load sources directly (Node strips the types), builds load the compiled file next to this one.
const CORE_URL = new URL(import.meta.url.endsWith(".ts") ? "./visual-compare-core.ts" : "./visual-compare-core.js", import.meta.url).href;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.coreUrl).then(
  (core) => {
    const result = core.compareImagesSync(workerData.a, workerData.b, workerData.opts);
    parentPort.postMessage({ result }, result.diffPng ? [result.diffPng.buffer] : []);
  },
).catch((err) => parentPort.postMessage({ error: String((err && err.stack) || err) }));
`;

/**
 * Compares two PNGs in a worker thread. The inputs are copied, never detached. Rejects on an unreadable PNG
 * or a worker failure; the caller decides what that means (visual regression records `skipped`).
 */
export function compareImages(a: Uint8Array, b: Uint8Array, opts: VisualCompareOptions): Promise<VisualCompareResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { coreUrl: CORE_URL, a, b, opts } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      void worker.terminate();
    };
    worker.once("message", (msg: { result?: VisualCompareResult; error?: string }) =>
      finish(() => (msg.result ? resolve(msg.result) : reject(new Error(`Image comparison failed: ${msg.error}`)))),
    );
    worker.once("error", (err) => finish(() => reject(err)));
    worker.once("exit", (code) => finish(() => reject(new Error(`Image comparison worker exited with code ${code}`))));
  });
}
