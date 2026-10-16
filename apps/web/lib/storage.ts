import { RUN_LIMITS } from "@defe2end/shared";
import { LocalStorage } from "@defe2end/shared/server";

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
