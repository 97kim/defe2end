import { RUN_LIMITS } from "@defe2end/shared";
import path from "node:path";
import { LocalStorage, setVisualCompareWorkerFile } from "@defe2end/shared/server";

/**
 * The bundled image comparison worker (visual regression, environment comparison). Bundling moves the engine
 * away from the core it would load, so the worker starts from this one-file build; `outputFileTracingIncludes`
 * (next.config.ts) puts it in the standalone output at the same place relative to the server's working
 * directory (apps/web, in dev and in standalone).
 */
export const VISUAL_COMPARE_WORKER_FILE = path.join(/* turbopackIgnore: true */ process.cwd(), "..", "..", "packages", "shared", "dist", "visual-compare-worker.cjs");
setVisualCompareWorkerFile(VISUAL_COMPARE_WORKER_FILE);

const globalForStorage = globalThis as { storage?: LocalStorage };

/** The file volume shared with the worker (`STORAGE_DIR`). */
export function getStorage(): LocalStorage {
  return (globalForStorage.storage ??= new LocalStorage(process.env.STORAGE_DIR || "./data/storage"));
}

/** `MIN_FREE_DISK_MB`: below it new runs are refused with 503 storage_low (contract section 3). */
export function minFreeDiskBytes(): number {
  const mb = Number(process.env.MIN_FREE_DISK_MB || RUN_LIMITS.minFreeDiskMb);
  return mb * 1024 * 1024;
}
