// Baseline storage and image comparison for the web server (stage 7 contract section 4).
import { storageBaselineFiles } from "@defe2end/shared/server";
import { getStorage } from "./storage";

export function baselineFiles() {
  return storageBaselineFiles(getStorage());
}
