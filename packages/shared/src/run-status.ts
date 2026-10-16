import { z } from "zod";

/** Terminal states of a run, as returned by `/api/v1` (plan section 2.3). */
export const RUN_TERMINAL_STATUSES = ["passed", "failed", "error", "cancelled", "timed_out"] as const;

export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUSES)[number];

/** Every run state (stage 3 contract section 4): `queued → running → terminal`, or `queued → cancelled`. */
export const RUN_STATUSES = ["queued", "running", ...RUN_TERMINAL_STATUSES] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export function isTerminalRunStatus(status: string): status is RunTerminalStatus {
  return (RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** CI treats only `passed` as success; every other terminal state fails the pipeline. */
export function isCiPass(status: RunTerminalStatus, warningCount = 0, failOnWarning = false): boolean {
  return status === "passed" && !(failOnWarning && warningCount > 0);
}

/** Whole-run retry (spec 4.3): total attempts including the first, an instance setting (`RUN_RETRY_ATTEMPTS`). */
export const DEFAULT_RUN_ATTEMPTS = 2;

/** Positive numbers count (a fraction rounds up); 0, negatives, non-numbers and empty fall back to 2. */
export function parseRunAttempts(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : DEFAULT_RUN_ATTEMPTS;
}

/** Only a `failed` attempt is run again, while attempts remain; the scenario toggle turns it off. */
export function shouldRetryRun(status: RunTerminalStatus, attempt: number, retryOnFailure: boolean, maxAttempts = DEFAULT_RUN_ATTEMPTS): boolean {
  return retryOnFailure && status === "failed" && attempt < maxAttempts;
}

/** The run's verdict is the last attempt's; "passed after retry" when it passed and earlier attempts exist. */
export function summarizeAttempts(statuses: readonly RunTerminalStatus[]): { status: RunTerminalStatus; passedAfterRetry: boolean } {
  const status = statuses.at(-1) ?? "error";
  return { status, passedAfterRetry: status === "passed" && statuses.length > 1 };
}

/**
 * Step result states (contract section 1). `error` is infrastructure, `timed_out`/`cancelled` mark the step that
 * was running when the run was stopped, `skipped` the steps that never ran or optional steps whose action
 * failed, `warning` a step that passed with a warning (spec 4.1).
 */
export const STEP_RESULT_STATUSES = ["passed", "warning", "failed", "error", "cancelled", "timed_out", "skipped"] as const;
export type StepResultStatus = (typeof STEP_RESULT_STATUSES)[number];

/**
 * Why a run was stopped from outside the step loop (contract section 4.2). Passed as `AbortSignal.reason`.
 * `worker_lost`: the worker could not renew its lease; `worker_shutdown`: SIGTERM grace ran out.
 */
export const ABORT_REASONS = ["cancelled", "timed_out", "worker_lost", "worker_shutdown"] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];

export function isAbortReason(value: unknown): value is AbortReason {
  return (ABORT_REASONS as readonly unknown[]).includes(value);
}

/** Run-level error codes (`Run.errorCode`), set when the run itself, not a step, went wrong or was stopped. */
export const RUN_ERROR_CODES = [
  "worker_lost",
  "worker_shutdown",
  "artifact_limit",
  "browser_launch_failed",
  "browser_crashed",
  "internal",
  "group_stopped", // DB only, never a runner verdict: a group child not started because an earlier one did not pass.
  // Desktop runs (stage 4 contract section 4), set by the server only:
  "desktop_lost", // lease expired, or a running run missing from the app's list after a reconnect
  "desktop_reconnected", // a dispatched queued run missing from the app's list after a reconnect
  "verdict_mismatch", // the app's verdict differs from the server's judgement of its steps
  "permission_lost", // the requester lost `run.create` before the run was sent
  "app_update_required", // the device no longer announces an action or option this run needs
  "auth_session_missing", // the environment needs the requester's login session and there is no valid one
  "variable_missing", // a personal variable the steps use has no value of the requester's (variables contract section 3)
] as const;
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];

/**
 * Why the last attempt ended other than by its steps (stage 4 contract section 4.3): cancel, the overall time
 * limit, or infrastructure (browser launch failed, lease lost, artifact limit…). The steps alone can't tell.
 */
export const stopCauseSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("cancelled") }),
  z.strictObject({ type: z.literal("timed_out") }),
  z.strictObject({ type: z.literal("infra"), code: z.enum(RUN_ERROR_CODES) }),
]);
export type StopCause = z.infer<typeof stopCauseSchema>;

export const NO_STOP: StopCause = { type: "none" };

/** The stop cause of an external stop reason (`AbortSignal.reason`). */
export function stopCauseOfAbort(reason: AbortReason): StopCause {
  return reason === "cancelled" || reason === "timed_out" ? { type: reason } : { type: "infra", code: reason };
}

export interface RunJudgement {
  status: RunTerminalStatus;
  /** Set for an `infra` stop. */
  errorCode?: RunErrorCode;
  /** Steps of the last attempt that ended `warning` (spec 4.2). */
  warningCount: number;
  attemptCount: number;
  passedAfterRetry: boolean;
}

/**
 * The run verdict, shared by the runner, the worker, the desktop app and the server re-checking a desktop run
 * (plan section 3, stage 4 contract section 4.3). `steps`: results of every attempt; the verdict is the last
 * attempt's (spec 4.3), and `stopCause` belongs to that attempt.
 * A stop from outside wins and is judged by its cause, never as `error` from the browser closing under it.
 * Otherwise: any infrastructure error → `error`, any failed step → `failed`, else `passed` (`warning` and `skipped` steps still pass).
 */
export function judgeRun(steps: readonly { attempt: number; status: StepResultStatus }[], stopCause: StopCause = NO_STOP): RunJudgement {
  const attemptCount = Math.max(1, ...steps.map((s) => s.attempt));
  const last = steps.filter((s) => s.attempt === attemptCount).map((s) => s.status);
  const warningCount = last.filter((s) => s === "warning").length;
  const judged = (status: RunTerminalStatus, errorCode?: RunErrorCode): RunJudgement => ({
    status,
    ...(errorCode ? { errorCode } : {}),
    warningCount,
    attemptCount,
    passedAfterRetry: status === "passed" && attemptCount > 1,
  });
  if (stopCause.type === "cancelled" || stopCause.type === "timed_out") return judged(stopCause.type);
  if (stopCause.type === "infra") return judged("error", stopCause.code);
  if (last.includes("error")) return judged("error");
  if (last.includes("failed")) return judged("failed");
  return judged("passed");
}
