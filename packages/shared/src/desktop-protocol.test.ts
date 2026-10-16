import { describe, expect, it } from "vitest";
import {
  compareVersions,
  DEFAULT_DEVICE,
  DESKTOP_CAPABILITIES,
  DESKTOP_PROTOCOL_VERSION,
  desktopCompleteRequestSchema,
  desktopStreamMessageSchema,
  desktopTokenRequestSchema,
  missingCapabilities,
  parseCommaList,
  parseDesktopClientHeader,
  STEP_ACTIONS,
  type ExecutionPlan,
} from "./index.js";

const plan: ExecutionPlan = {
  runId: "run_1",
  baseUrl: "http://127.0.0.1:3000",
  steps: [{ id: "s1", action: "goto", url: "/" }],
  variables: { PASSWORD: { value: "x", secret: true } },
  device: DEFAULT_DEVICE,
  stepTimeoutMs: 30_000,
  network: { blockPrivateNetworks: false },
  capture: { video: false, traceOnFailure: true },
};

describe("Defe2end-Client header", () => {
  it("parses app, runner and protocol in any order", () => {
    expect(parseDesktopClientHeader("app=1.2.0; runner=0.3.1; protocol=1")).toEqual({ app: "1.2.0", runner: "0.3.1", protocol: 1 });
    expect(parseDesktopClientHeader("app=1.2.0+build.7; runner=0.3.1; protocol=1")?.app).toBe("1.2.0+build.7");
    expect(parseDesktopClientHeader("protocol=1;app=1.2.0-beta.1;runner=0.3.1")).toEqual({ app: "1.2.0-beta.1", runner: "0.3.1", protocol: DESKTOP_PROTOCOL_VERSION });
  });

  it("rejects missing, duplicate or malformed fields", () => {
    for (const bad of [undefined, null, "", "app=1.2.0; runner=0.3.1", "app=1.2; runner=0.3.1; protocol=1", "app=1.2.0; runner=0.3.1; protocol=one", "app=1.2.0; app=1.3.0; runner=0.3.1; protocol=1", "app 1.2.0"]) {
      expect(parseDesktopClientHeader(bad)).toBeNull();
    }
  });

  it("compares versions numerically and splits comma lists", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2.0", "1.2.0-beta.1")).toBe(1);
    expect(compareVersions("1.2.0-beta.2", "1.2.0-beta.10")).toBe(-1);
    expect(compareVersions("1.2.0-alpha", "1.2.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.2.0-1", "1.2.0-alpha")).toBe(-1);
    expect(compareVersions("1.2.0+build.5", "1.2.0")).toBe(0);
    expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
    expect(parseCommaList(" a, ,b ,")).toEqual(["a", "b"]);
    expect(parseCommaList(undefined)).toEqual([]);
  });
});

describe("capabilities", () => {
  it("are every step action plus the feature flags", () => {
    for (const action of STEP_ACTIONS) expect(DESKTOP_CAPABILITIES).toContain(action);
    expect(DESKTOP_CAPABILITIES).toEqual(expect.arrayContaining(["stop-run", "auth-session", "video", "test-run"]));
    expect(missingCapabilities(["goto", "video", "goto"], ["goto"])).toEqual(["video"]);
  });
});

describe("stream messages", () => {
  it("accept a run with plan, policy, attachments and concurrency", () => {
    const run = {
      type: "run",
      runId: "run_1",
      workspaceId: "ws",
      groupRunId: null,
      groupIndex: null,
      trigger: "manual",
      plan,
      policy: { retryAttempts: 2, runTimeoutMs: 900_000, video: false, traceOnFailure: true },
      attachments: [{ id: "a1", name: "file.png", version: 1, contentType: "image/png", sizeBytes: 3 }],
      concurrency: 1,
    };
    expect(desktopStreamMessageSchema.parse(run)).toEqual(run);
    expect(desktopStreamMessageSchema.safeParse({ ...run, policy: { ...run.policy, retryAttempts: 0 } }).success).toBe(false);
    expect(desktopStreamMessageSchema.safeParse({ ...run, plan: { ...plan, extra: 1 } }).success).toBe(false);
  });

  it("accept the control messages and reject unknown types", () => {
    for (const m of [
      { type: "connected", connectionId: "c1", minimum: "0.0.0", serverVersion: "0.0.0", recorder: { testAttributes: ["data-qa"] } },
      { type: "capture-auth-state", requestId: "r1", workspaceId: "ws", environmentId: "env", url: "https://example.test" },
      { type: "stop-run", runId: "run_1" },
      { type: "heartbeat" },
    ]) {
      expect(desktopStreamMessageSchema.safeParse(m).success).toBe(true);
    }
    expect(desktopStreamMessageSchema.safeParse({ type: "error" }).success).toBe(false);
  });
});

describe("requests", () => {
  it("token exchange needs a UUID install id and a short label", () => {
    expect(desktopTokenRequestSchema.safeParse({ installId: "6f1c2a8e-3b4d-4c5e-9f60-718293a4b5c6", label: "ab12" }).success).toBe(true);
    expect(desktopTokenRequestSchema.safeParse({ installId: "pc-1", label: "ab12" }).success).toBe(false);
    expect(desktopTokenRequestSchema.safeParse({ installId: "6f1c2a8e-3b4d-4c5e-9f60-718293a4b5c6", label: "x".repeat(41) }).success).toBe(false);
  });

  it("completion carries the claim token, stop cause and every attempt's steps", () => {
    const step = { index: 0, stepId: "s1", action: "goto", status: "failed" as const, attempt: 1, attempts: 2, startedAt: new Date().toISOString(), durationMs: 5 };
    const body = { claimToken: "t", verdict: "passed", stopCause: { type: "none" }, attemptCount: 2, passedAfterRetry: true, durationMs: 10, steps: [step, { ...step, attempt: 2, status: "passed" as const }] };
    expect(desktopCompleteRequestSchema.parse(body)).toEqual(body);
    expect(desktopCompleteRequestSchema.safeParse({ ...body, stopCause: { type: "infra", code: "browser_launch_failed" } }).success).toBe(true);
    expect(desktopCompleteRequestSchema.safeParse({ ...body, stopCause: { type: "infra", code: "nope" } }).success).toBe(false);
    expect(desktopCompleteRequestSchema.safeParse({ ...body, claimToken: undefined }).success).toBe(false);
  });
});
