// Storage access for visual baselines (stage 7 contract section 4), shared by the worker and the web app.
import { Readable } from "node:stream";
import { baselineKey, type StorageDriver } from "./storage.js";
import { compareImages } from "./visual-compare.js";

/** Largest baseline or screenshot read back for a comparison (the app download cap, section 4). */
export const BASELINE_MAX_BYTES = 20 * 1024 * 1024;

export async function readStoredBytes(storage: StorageDriver, key: string, maxBytes = BASELINE_MAX_BYTES): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of await storage.get(key)) {
    total += (chunk as Uint8Array).byteLength;
    if (total > maxBytes) throw new Error(`Stored file is larger than ${maxBytes} bytes`);
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export function storageBaselineFiles(storage: StorageDriver) {
  return {
    read: (key: string) => readStoredBytes(storage, key),
    async writeCopy(workspaceId: string, bytes: Uint8Array) {
      const key = baselineKey(workspaceId);
      await storage.put(key, Readable.from([Buffer.from(bytes)]));
      return key;
    },
    delete: (key: string) => storage.delete(key),
    compare: (baseline: Uint8Array, current: Uint8Array, tolerance: number) => compareImages(baseline, current, { mode: "regression", tolerance }),
  };
}
