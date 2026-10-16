import { VERSIONS } from "@defe2end/shared";

/** Step execution engine shared by the worker and the desktop app (stage 3 contract section 5). */
export const RUNNER_VERSION = VERSIONS.runner;

export { killGroup, listMarkedBrowsers, sweepBrowsers, type MarkedProcess } from "./browser.js";
export { hostResolverRules, isBlockedUrl, type NetworkRules } from "./network.js";
export { runPlan, type RunPlanOptions } from "./run.js";
export { runWithRetries, type RetriedRun, type RunRetryPolicy, type RunWithRetriesOptions } from "./retry.js";
export type { UploadFile } from "./actions.js";
export { collectRenderConditions, detectRuntime, fontSetId, renderConditionDiff, type RenderConditions, type RunRuntime } from "./render-conditions.js";
