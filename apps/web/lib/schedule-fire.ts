// Schedule fire dependencies with this process's storage (the worker builds its own with `scheduleFireDeps`).
import { scheduleFireDeps as fireDeps } from "@defe2end/db";
import { getStorage, minFreeDiskBytes } from "./storage";

export const scheduleFireDeps = fireDeps({ freeBytes: () => getStorage().freeBytes(), minFreeBytes: minFreeDiskBytes });
