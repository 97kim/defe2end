import { describe, expect, it } from "vitest";
import { DEFAULT_DEVICE, executionPlanSchema, isCiPass, judgeRun, parseRunAttempts, runnerEventSchema, shouldRetryRun, stopCauseOf, stopCauseOfAbort, stopCauseSchema, substituteVariables, summarizeAttempts, type StepResultStatus } from "./index.js";

describe("whole-run retry and CI", () => {
  it("retries only a failed first attempt when the scenario allows it", () => {
    expect(shouldRetryRun("failed", 1, true)).toBe(true);
    expect(shouldRetryRun("failed", 2, true)).toBe(false);
    expect(shouldRetryRun("failed", 1, false)).toBe(false);
    for (const s of ["error", "cancelled", "timed_out", "passed"] as const) expect(shouldRetryRun(s, 1, true)).toBe(false);
  });

  it("honours the instance's total attempts: 1 never retries, 3 retries twice", () => {
    expect(shouldRetryRun("failed", 1, true, 1)).toBe(false);
    expect(shouldRetryRun("failed", 2, true, 3)).toBe(true);
    expect(shouldRetryRun("failed", 3, true, 3)).toBe(false);
    expect(shouldRetryRun("failed", 1, false, 3)).toBe(false);
  });

  it("reads RUN_RETRY_ATTEMPTS: default 2, invalid → 2, fractions round up", () => {
    expect(parseRunAttempts(undefined)).toBe(2);
    expect(parseRunAttempts("1")).toBe(1);
    expect(parseRunAttempts("3")).toBe(3);
    expect(parseRunAttempts("2.5")).toBe(3);
    for (const raw of ["", " ", "0", "-1", "abc", "NaN", "Infinity"]) expect(parseRunAttempts(raw)).toBe(2);
  });

  it("takes the last attempt's verdict and marks passed after retry", () => {
    expect(summarizeAttempts(["failed", "passed"])).toEqual({ status: "passed", passedAfterRetry: true });
    expect(summarizeAttempts(["passed"])).toEqual({ status: "passed", passedAfterRetry: false });
    expect(summarizeAttempts(["failed", "failed"])).toEqual({ status: "failed", passedAfterRetry: false });
  });

  it("CI fails a passed run with warnings only with failOnWarning", () => {
    expect(isCiPass("passed", 2)).toBe(true);
    expect(isCiPass("passed", 2, true)).toBe(false);
    expect(isCiPass("passed", 0, true)).toBe(true);
  });
});

describe("judgeRun", () => {
  const one = (...statuses: StepResultStatus[]) => statuses.map((status) => ({ attempt: 1, status }));

  it("passes when no step failed: warning and optional skipped steps still pass", () => {
    expect(judgeRun(one("passed", "passed")).status).toBe("passed");
    expect(judgeRun([]).status).toBe("passed");
    expect(judgeRun(one("passed", "warning", "skipped", "warning"))).toEqual({ status: "passed", warningCount: 2, attemptCount: 1, passedAfterRetry: false });
  });

  it("fails on a failed step even when later steps continued", () => {
    expect(judgeRun(one("passed", "failed", "skipped")).status).toBe("failed");
  });

  it("an infrastructure error outranks a failure", () => {
    expect(judgeRun(one("failed", "error"))).toEqual({ status: "error", warningCount: 0, attemptCount: 1, passedAfterRetry: false });
  });

  it("a stop from outside is judged by its cause, not by the browser closing", () => {
    expect(judgeRun(one("passed", "error"), { type: "cancelled" }).status).toBe("cancelled");
    expect(judgeRun(one("passed", "timed_out"), { type: "timed_out" }).status).toBe("timed_out");
    expect(judgeRun(one("failed"), { type: "timed_out" }).status).toBe("timed_out");
  });

  it("an infra stop is error with its code, whatever the steps say", () => {
    expect(judgeRun(one("skipped", "skipped"), { type: "infra", code: "browser_launch_failed" })).toMatchObject({ status: "error", errorCode: "browser_launch_failed" });
    expect(judgeRun(one("passed"), stopCauseOfAbort("worker_lost"))).toMatchObject({ status: "error", errorCode: "worker_lost" });
    expect(judgeRun(one("passed"), { type: "none" }).errorCode).toBeUndefined();
  });

  it("judges the last attempt: passed after retry", () => {
    const steps = [
      { attempt: 1, status: "passed" as const },
      { attempt: 1, status: "failed" as const },
      { attempt: 2, status: "passed" as const },
      { attempt: 2, status: "warning" as const },
    ];
    expect(judgeRun(steps)).toEqual({ status: "passed", warningCount: 1, attemptCount: 2, passedAfterRetry: true });
    expect(judgeRun(steps.slice(0, 2)).status).toBe("failed");
    expect(judgeRun([...steps.slice(0, 2), { attempt: 2, status: "failed" }])).toMatchObject({ status: "failed", attemptCount: 2, passedAfterRetry: false });
  });

  it("matches the stop cause a verdict reports", () => {
    expect(stopCauseOf({ status: "error", errorCode: "artifact_limit", warningCount: 0 })).toEqual({ type: "infra", code: "artifact_limit" });
    expect(stopCauseOf({ status: "error", warningCount: 0 })).toEqual({ type: "none" });
    expect(stopCauseOf({ status: "cancelled", warningCount: 0 })).toEqual({ type: "cancelled" });
    expect(stopCauseOf({ status: "failed", warningCount: 0 })).toEqual({ type: "none" });
  });

  it("parses stop causes strictly", () => {
    expect(stopCauseSchema.parse({ type: "infra", code: "browser_crashed" })).toEqual({ type: "infra", code: "browser_crashed" });
    expect(stopCauseSchema.safeParse({ type: "infra" }).success).toBe(false);
    expect(stopCauseSchema.safeParse({ type: "infra", code: "nope" }).success).toBe(false);
    expect(stopCauseSchema.safeParse({ type: "none", code: "internal" }).success).toBe(false);
  });
});

describe("substituteVariables", () => {
  const vars = {
    USER: { value: "demo", secret: false },
    PASSWORD: { value: "s3cret", secret: true },
    EMPTY: { value: "", secret: true },
    TEMPLATE: { value: "{{PASSWORD}}", secret: false },
  };

  it("replaces keys and reports the secret values used", () => {
    expect(substituteVariables("{{USER}}:{{PASSWORD}}", vars)).toEqual({ ok: true, text: "demo:s3cret", secrets: ["s3cret"] });
  });

  it("substitutes once: a value that looks like a template stays literal", () => {
    expect(substituteVariables("{{TEMPLATE}}", vars)).toEqual({ ok: true, text: "{{PASSWORD}}", secrets: [] });
  });

  it("leaves an unknown key literal and fails on an empty secret", () => {
    expect(substituteVariables("a{{NOPE}}b", vars)).toEqual({ ok: true, text: "a{{NOPE}}b", secrets: [] });
    expect(substituteVariables("{{constructor}}", vars)).toEqual({ ok: true, text: "{{constructor}}", secrets: [] });
    expect(substituteVariables("x {{EMPTY}}", vars)).toEqual({ ok: false, code: "missing_secret", key: "EMPTY" });
  });

  it("takes names that start with a digit and substitutes empty values", () => {
    const more = { "1USER": { value: "one", secret: false }, _: { value: "", secret: false } };
    expect(substituteVariables("{{1USER}}|{{_}}|{{a-b}}|{{ x }}", more)).toEqual({ ok: true, text: "one||{{a-b}}|{{ x }}", secrets: [] });
  });
});

describe("runnerEventSchema", () => {
  it("rejects unknown keys so producers and consumers stay in step", () => {
    const event = { type: "log", level: "info", message: "hi" };
    expect(runnerEventSchema.parse(event)).toEqual(event);
    expect(() => runnerEventSchema.parse({ ...event, extra: 1 })).toThrow();
  });
});

describe("executionPlanSchema", () => {
  const plan = {
    runId: "cmv3abc",
    baseUrl: "https://example.com",
    steps: [{ id: "s1", action: "goto", url: "/" }],
    variables: {},
    device: DEFAULT_DEVICE,
    stepTimeoutMs: 15_000,
    network: { blockPrivateNetworks: false },
    capture: { video: false, traceOnFailure: true },
  };

  it("accepts a complete plan and refuses unknown keys", () => {
    expect(executionPlanSchema.parse(plan)).toEqual(plan);
    expect(() => executionPlanSchema.parse({ ...plan, extra: true })).toThrow();
  });

  it("takes only an id as runId: it marks the browser process on the command line", () => {
    expect(() => executionPlanSchema.parse({ ...plan, runId: "x --remote-debugging-port=9222" })).toThrow();
  });

  it("takes an optional login session in Playwright's storage state format", () => {
    const storageState = {
      cookies: [{ name: "sid", value: "v", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
      origins: [{ origin: "https://example.com", localStorage: [{ name: "token", value: "t" }] }],
    };
    expect(executionPlanSchema.parse({ ...plan, storageState })).toEqual({ ...plan, storageState });
    expect(() => executionPlanSchema.parse({ ...plan, storageState: { cookies: [{ name: "sid", value: "v" }], origins: [] } })).toThrow();
    expect(() => executionPlanSchema.parse({ ...plan, storageState: { ...storageState, extra: 1 } })).toThrow();
  });
});
