import { shouldRetryRun, stopCauseOf, summarizeAttempts, type AbortReason, type RunVerdict, type StopCause } from "@defe2end/shared";

/** Whole-run retry policy (spec 4.3). The worker reads it from its settings, the desktop app gets it from the server. */
export interface RunRetryPolicy {
  /** Total attempts including the first (`RUN_RETRY_ATTEMPTS`, see `parseRunAttempts`). */
  maxAttempts: number;
  /** Scenario setting; off means one attempt whatever `maxAttempts` says. */
  retryOnFailure: boolean;
  /** Overall time limit, retries and waits included (contract section 3). */
  runTimeoutMs: number;
}

export interface RunWithRetriesOptions {
  policy: RunRetryPolicy;
  /** Local time the overall limit counts from (the worker: when the claim was sent). */
  startedAt: number;
  /** The run's abort signal; once aborted no further attempt starts. */
  signal: AbortSignal;
  /** Stops the run through `signal`; called with `timed_out` when the overall limit runs out. */
  stop(reason: AbortReason): void;
  /** Runs attempt `attempt` (1-based), usually `runPlan` with `{ ...plan, attempt }`. */
  runAttempt(attempt: number): Promise<RunVerdict>;
  /** Called before attempt `next` starts again after a `failed` one. */
  onRetry?(next: number, failed: RunVerdict): void;
}

export interface RetriedRun {
  /** The last attempt's verdict. */
  verdict: RunVerdict;
  attemptCount: number;
  passedAfterRetry: boolean;
  /** What the desktop app reports to the server with the steps (stage 4 contract section 4.3). */
  stopCause: StopCause;
}

/**
 * Whole-run retry (action spec 4.3), shared by the worker and the desktop app: runs again after `failed`
 * only, never after error, worker loss, cancel or timeout, while attempts remain. The overall time limit
 * covers every attempt. A throwing `runAttempt` ends the loop and the error goes to the caller.
 */
export async function runWithRetries(opts: RunWithRetriesOptions): Promise<RetriedRun> {
  const { policy, signal } = opts;
  const timeoutTimer = setTimeout(() => opts.stop("timed_out"), opts.startedAt + policy.runTimeoutMs - Date.now());
  const statuses: RunVerdict["status"][] = [];
  try {
    for (let attempt = 1; ; attempt++) {
      const verdict = await opts.runAttempt(attempt);
      statuses.push(verdict.status);
      if (!shouldRetryRun(verdict.status, attempt, policy.retryOnFailure, policy.maxAttempts) || signal.aborted) {
        return { verdict, attemptCount: attempt, passedAfterRetry: summarizeAttempts(statuses).passedAfterRetry, stopCause: stopCauseOf(verdict) };
      }
      opts.onRetry?.(attempt + 1, verdict);
    }
  } finally {
    clearTimeout(timeoutTimer);
  }
}
