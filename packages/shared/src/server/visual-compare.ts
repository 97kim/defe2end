// Runs the image comparison off the calling thread (contract section 3: big images must not hold the event loop).
import { Worker } from "node:worker_threads";
import { compareImagesSync, type VisualCompareOptions, type VisualCompareResult } from "./visual-compare-core.js";

export * from "./visual-compare-core.js";

/**
 * When the worker can't load the core next to this file (a packaged app whose archive the worker thread can't
 * read), images up to this many pixels each are compared on the calling thread instead; bigger ones still fail
 * (contract section 3: big images must not hold the event loop).
 */
export const SYNC_FALLBACK_MAX_PIXELS = 1_500_000;

function pngPixels(png: Uint8Array): number {
  if (png.length < 24) return Infinity;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return view.getUint32(16) * view.getUint32(20);
}

// Tests load sources directly (Node strips the types), builds load the compiled file next to this one.
const CORE_URL = new URL(import.meta.url.endsWith(".ts") ? "./visual-compare-core.ts" : "./visual-compare-core.js", import.meta.url).href;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.coreUrl).then(
  (core) => {
    try {
      const result = core.compareImagesSync(workerData.a, workerData.b, workerData.opts);
      parentPort.postMessage({ result }, result.diffPng ? [result.diffPng.buffer] : []);
    } catch (err) {
      parentPort.postMessage({ error: String((err && err.stack) || err) });
    }
  },
  (err) => parentPort.postMessage({ error: String((err && err.stack) || err), loadError: true }),
);
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
    worker.once("message", (msg: { result?: VisualCompareResult; error?: string; loadError?: boolean }) =>
      finish(() => {
        if (msg.result) return resolve(msg.result);
        if (msg.loadError && pngPixels(a) <= SYNC_FALLBACK_MAX_PIXELS && pngPixels(b) <= SYNC_FALLBACK_MAX_PIXELS) {
          try {
            return resolve(compareImagesSync(a, b, opts));
          } catch (err) {
            return reject(err);
          }
        }
        reject(new Error(`Image comparison failed: ${msg.error}`));
      }),
    );
    worker.once("error", (err) => finish(() => reject(err)));
    worker.once("exit", (code) => finish(() => reject(new Error(`Image comparison worker exited with code ${code}`))));
  });
}
