import type { RunVerdict } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import { runWithRetries, type RunRetryPolicy } from "./index.js";

const verdict = (status: RunVerdict["status"], extra: Partial<RunVerdict> = {}): RunVerdict => ({ status, warningCount: 0, ...extra });

/** Runs the loop over scripted attempt verdicts and records which attempts ran. */
async function retry(script: RunVerdict[], policy: Partial<RunRetryPolicy> = {}, controller = new AbortController()) {
  const ran: number[] = [];
  const retries: number[] = [];
  const result = await runWithRetries({
    policy: { maxAttempts: 2, retryOnFailure: true, runTimeoutMs: 60_000, ...policy },
    startedAt: Date.now(),
    signal: controller.signal,
    stop: (reason) => controller.abort(reason),
    runAttempt: async (n) => {
      ran.push(n);
      return script[n - 1]!;
    },
    onRetry: (next) => void retries.push(next),
  });
  return { ...result, ran, retries };
}

describe("runWithRetries", () => {
  it("runs again after a failed attempt and reports passed after retry", async () => {
    const r = await retry([verdict("failed"), verdict("passed")]);
    expect(r).toMatchObject({ verdict: { status: "passed" }, attemptCount: 2, passedAfterRetry: true, stopCause: { type: "none" }, ran: [1, 2], retries: [2] });
  });

  it("stops at the attempt limit; the verdict is the last attempt's", async () => {
    expect(await retry([verdict("failed"), verdict("failed"), verdict("passed")])).toMatchObject({ verdict: { status: "failed" }, attemptCount: 2, passedAfterRetry: false, ran: [1, 2] });
    expect(await retry([verdict("failed"), verdict("failed"), verdict("passed")], { maxAttempts: 3 })).toMatchObject({ attemptCount: 3, passedAfterRetry: true });
    expect(await retry([verdict("failed"), verdict("passed")], { maxAttempts: 1 })).toMatchObject({ verdict: { status: "failed" }, attemptCount: 1 });
  });

  it("the scenario toggle turns retry off", async () => {
    expect(await retry([verdict("failed"), verdict("passed")], { retryOnFailure: false })).toMatchObject({ verdict: { status: "failed" }, ran: [1] });
  });

  it("never retries error, cancel or timeout, and reports their stop cause", async () => {
    expect(await retry([verdict("error", { errorCode: "browser_launch_failed" })])).toMatchObject({ ran: [1], stopCause: { type: "infra", code: "browser_launch_failed" } });
    expect(await retry([verdict("error")])).toMatchObject({ ran: [1], stopCause: { type: "none" } });
    expect(await retry([verdict("cancelled")])).toMatchObject({ ran: [1], stopCause: { type: "cancelled" } });
    expect(await retry([verdict("timed_out")])).toMatchObject({ ran: [1], stopCause: { type: "timed_out" } });
  });

  it("does not start another attempt once the run was stopped", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    expect(await retry([verdict("failed"), verdict("passed")], {}, controller)).toMatchObject({ verdict: { status: "failed" }, ran: [1] });
  });

  it("stops the run with timed_out when the overall limit runs out, across attempts", async () => {
    const controller = new AbortController();
    const reasons: unknown[] = [];
    const result = await runWithRetries({
      policy: { maxAttempts: 2, retryOnFailure: true, runTimeoutMs: 50 },
      startedAt: Date.now(),
      signal: controller.signal,
      stop: (reason) => {
        reasons.push(reason);
        controller.abort(reason);
      },
      runAttempt: async (n) => {
        if (n === 1) return verdict("failed");
        await new Promise((r) => controller.signal.addEventListener("abort", r, { once: true }));
        return verdict("timed_out");
      },
    });
    expect(reasons).toEqual(["timed_out"]);
    expect(result).toMatchObject({ verdict: { status: "timed_out" }, attemptCount: 2, stopCause: { type: "timed_out" } });
  });

  it("passes an attempt's exception to the caller and clears the timer", async () => {
    const controller = new AbortController();
    await expect(
      runWithRetries({ policy: { maxAttempts: 2, retryOnFailure: true, runTimeoutMs: 20 }, startedAt: Date.now(), signal: controller.signal, stop: (r) => controller.abort(r), runAttempt: async () => Promise.reject(new Error("boom")) }),
    ).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 40));
    expect(controller.signal.aborted).toBe(false);
  });
});
