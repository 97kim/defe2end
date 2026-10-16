import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopRunMessage, ExecutionPlan, RunVerdict } from "@defe2end/shared";
import type { RunPlanOptions } from "@defe2end/runner";
import { Generations } from "./generation.js";
import { RunExecutor, type RunProgress } from "./executor.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function message(runId: string, extra: Partial<DesktopRunMessage> = {}): DesktopRunMessage {
  return {
    type: "run",
    runId,
    workspaceId: "w1",
    groupRunId: null,
    groupIndex: null,
    trigger: "manual",
    plan: { runId, baseUrl: "https://shop.example.com", steps: [], variables: { PW: { value: "hunter2", secret: true } }, device: { viewport: { width: 1280, height: 720 } }, stepTimeoutMs: 30_000, network: { blockPrivateNetworks: false }, capture: { video: false, traceOnFailure: false } },
    policy: { retryAttempts: 2, runTimeoutMs: 600_000, video: false, traceOnFailure: false },
    attachments: [],
    concurrency: 1,
    ...extra,
  };
}

/** A runner that waits for its abort signal and then reports the stop like the real one. */
function waitingRunner(launches: string[]) {
  return vi.fn(async (plan: ExecutionPlan, opts: RunPlanOptions): Promise<RunVerdict> => {
    launches.push(plan.runId);
    await new Promise<void>((r) => opts.signal.addEventListener("abort", () => r(), { once: true }));
    const reason = opts.signal.reason as string;
    await opts.onEvent({ type: "stepFinished", result: { index: 0, stepId: "s", action: "click", status: reason === "cancelled" ? "cancelled" : "error", attempt: plan.attempt ?? 1, attempts: 1, startedAt: new Date().toISOString(), durationMs: 1 } });
    return reason === "cancelled" ? { status: "cancelled", warningCount: 0 } : { status: "error", errorCode: "worker_lost", warningCount: 0 };
  });
}

afterEach(() => vi.useRealTimers());

function setup(handler: (url: string) => Response, runner?: (plan: ExecutionPlan, opts: RunPlanOptions) => Promise<RunVerdict>, launchesOut: string[] = [], headless?: () => boolean) {
  const launches = launchesOut;
  const reports: { runId: string; body: unknown; secrets: readonly string[] }[] = [];
  const progress: RunProgress[] = [];
  const request = vi.fn(async (url: string) => handler(url));
  const executor = new RunExecutor({
    api: { request, json: vi.fn() } as never,
    ticket: new Generations().ticket(),
    owner: () => ({ userId: "u1", deviceId: "d1" }),
    report: async (runId, _owner, body, secrets) => void reports.push({ runId, body, secrets }),
    pendingReports: () => 0,
    runPlan: runner ?? waitingRunner(launches),
    ownerMark: "test",
    ...(headless ? { headless } : {}),
    sandbox: true,
    onProgress: (p) => progress.push(p),
  });
  return { executor, launches, reports, progress, request };
}

const lease = () => new Date(Date.now() + 90_000).toISOString();

describe("RunExecutor", () => {
  it("runs one at a time, launches once per run number, and reports a stop-run as cancelled", async () => {
    vi.useFakeTimers();
    const { executor, launches, reports } = setup((url) => (url.endsWith("/start") ? json(200, { status: "running", claimToken: "c", leaseExpiresAt: lease(), leaseRemainingMs: 90_000 }) : json(200, {})));
    executor.enqueue(message("r1"));
    executor.enqueue(message("r1"));
    executor.enqueue(message("r2"));
    await vi.advanceTimersByTimeAsync(0);
    expect(launches).toEqual(["r1"]);
    expect(executor.activeRunIds()).toEqual(["r1", "r2"]);
    executor.stop("r2");
    executor.stop("r1");
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ runId: "r1", body: { claimToken: "c", verdict: "cancelled", stopCause: { type: "cancelled" } }, secrets: ["hunter2"] });
    expect(launches).toEqual(["r1"]);
  });

  it("stops within 10 s of losing the lease and reports nothing", async () => {
    vi.useFakeTimers();
    let heartbeat = 0;
    const { executor, reports, progress } = setup((url) => {
      if (url.endsWith("/start")) return json(200, { status: "running", claimToken: "c", leaseExpiresAt: lease(), leaseRemainingMs: 90_000 });
      if (url.endsWith("/heartbeat")) return ++heartbeat === 1 ? json(200, { leaseExpiresAt: lease(), leaseRemainingMs: 90_000, cancelRequested: false }) : json(409, { code: "lease_lost" });
      return json(200, {});
    });
    executor.enqueue(message("r1"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(progress.at(-1)?.phase).toBe("running");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(progress.at(-1)).toMatchObject({ phase: "done", verdict: { dropped: "ownership_lost" } });
    expect(reports).toHaveLength(0);
  });

  it("stops on its own 10 s before the lease ends when the server is silent", async () => {
    vi.useFakeTimers();
    const { executor, reports, progress } = setup((url) => {
      if (url.endsWith("/start")) return json(200, { status: "running", claimToken: "c", leaseExpiresAt: lease(), leaseRemainingMs: 90_000 });
      throw new TypeError("network down");
    });
    executor.enqueue(message("r1"));
    await vi.advanceTimersByTimeAsync(79_000);
    expect(progress.at(-1)?.phase).toBe("running");
    await vi.advanceTimersByTimeAsync(1_001);
    expect(progress.at(-1)).toMatchObject({ phase: "done", verdict: { dropped: "ownership_lost" } });
    expect(reports).toHaveLength(0);
  });

  it("retries the start ACK with 0.5 s and 1.5 s, then backs off 5 s", async () => {
    vi.useFakeTimers();
    let starts = 0;
    const { executor } = setup((url) => (url.endsWith("/start") ? (starts++, json(503, {})) : json(200, {})));
    executor.enqueue(message("r1"));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(starts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toBe(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts).toBe(4);
    executor.stop("r1");
    await vi.advanceTimersByTimeAsync(0);
  });

  it("caps group concurrency at 4", async () => {
    vi.useFakeTimers();
    const { executor, launches } = setup((url) => (url.endsWith("/start") ? json(200, { status: "running", claimToken: "c", leaseExpiresAt: lease(), leaseRemainingMs: 90_000 }) : json(200, {})));
    for (let i = 0; i < 6; i++) executor.enqueue(message(`g${i}`, { groupRunId: "g", groupIndex: i, concurrency: 10 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(launches).toHaveLength(4);
    await executor.shutdown(10);
  });

  it("times the lease on the local monotonic clock, not the server's wall clock", async () => {
    vi.useFakeTimers();
    // A PC clock 5 minutes slow sees the server's leaseExpiresAt 6.5 minutes away.
    const skewed = () => new Date(Date.now() + 90_000 + 300_000).toISOString();
    const { executor, progress } = setup((url) => {
      if (url.endsWith("/start")) return json(200, { status: "running", claimToken: "c", leaseExpiresAt: skewed(), leaseRemainingMs: 90_000 });
      throw new TypeError("network down");
    });
    executor.enqueue(message("r1"));
    await vi.advanceTimersByTimeAsync(80_001);
    expect(progress.at(-1)).toMatchObject({ phase: "done", verdict: { dropped: "ownership_lost" } });
  });

  it("gives the runner the attachments pinned in the run message", async () => {
    vi.useFakeTimers();
    const files: unknown[] = [];
    const runner = vi.fn(async (_plan: ExecutionPlan, opts: RunPlanOptions): Promise<RunVerdict> => {
      const file = await opts.resolveAttachment!("terms.pdf");
      files.push(file && { name: file.name, mimeType: file.mimeType, text: file.buffer.toString() });
      files.push(await opts.resolveAttachment!("unknown.pdf"));
      return { status: "passed", warningCount: 0 };
    });
    const urls: string[] = [];
    const { executor } = setup((url) => {
      urls.push(url);
      if (url.endsWith("/start")) return json(200, { status: "running", claimToken: "c", leaseExpiresAt: lease(), leaseRemainingMs: 90_000 });
      if (url.endsWith("/attachments/att1")) return new Response("PDF!", { status: 200 });
      return json(200, {});
    }, runner);
    executor.enqueue(message("r1", { attachments: [{ id: "att1", name: "terms.pdf", version: 2, contentType: "application/pdf", sizeBytes: 4 }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(files).toEqual([{ name: "terms.pdf", mimeType: "application/pdf", text: "PDF!" }, undefined]);
    expect(urls.filter((u) => u.includes("/attachments/"))).toEqual(["/api/desktop/runs/r1/attachments/att1"]);
  });

  it("counts leaseRemainingMs from when start was sent, not 90 s per answer", async () => {
    vi.useFakeTimers();
    // A repeated start: the server's lease has only 30 s left.
    const { executor, progress } = setup((url) => {
      if (url.endsWith("/start")) return json(200, { status: "running", claimToken: "c", leaseRemainingMs: 30_000 });
      throw new TypeError("network down");
    });
    executor.enqueue(message("r1"));
    await vi.advanceTimersByTimeAsync(19_000);
    expect(progress.at(-1)?.phase).toBe("running");
    await vi.advanceTimersByTimeAsync(1_001);
    expect(progress.at(-1)).toMatchObject({ phase: "done", verdict: { dropped: "ownership_lost" } });
  });

  it("renews once before launching when an older server gives no time left", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const launches: string[] = [];
    const { executor } = setup(
      (url) => {
        order.push(url.split("/").at(-1)!);
        if (url.endsWith("/start")) return json(200, { status: "running", claimToken: "c" });
        if (url.endsWith("/heartbeat")) return json(200, { leaseExpiresAt: lease(), leaseRemainingMs: 90_000, cancelRequested: false });
        return json(200, {});
      },
      undefined,
      launches,
    );
    executor.enqueue(message("r1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(order.slice(0, 2)).toEqual(["start", "heartbeat"]);
    expect(launches).toEqual(["r1"]);
    executor.stop("r1");
    await vi.advanceTimersByTimeAsync(0);
  });

  it("shows the browser by default and reads the hide setting when each run starts", async () => {
    vi.useFakeTimers();
    const modes: (boolean | undefined)[] = [];
    const runner = vi.fn(async (_plan: ExecutionPlan, opts: RunPlanOptions): Promise<RunVerdict> => {
      modes.push(opts.headless);
      return { status: "passed", warningCount: 0 };
    });
    const ok = (url: string) => (url.endsWith("/start") ? json(200, { status: "running", claimToken: "c", leaseRemainingMs: 90_000 }) : json(200, {}));
    const visible = setup(ok, runner);
    visible.executor.enqueue(message("r1"));
    await vi.advanceTimersByTimeAsync(0);
    let hide = false;
    const toggled = setup(ok, runner, [], () => hide);
    toggled.executor.enqueue(message("r2"));
    await vi.advanceTimersByTimeAsync(0);
    hide = true;
    toggled.executor.enqueue(message("r3"));
    await vi.advanceTimersByTimeAsync(0);
    expect(modes).toEqual([false, false, true]);
    expect(runner.mock.calls.every(([, opts]) => opts.userCanClose === true)).toBe(true);
  });
});
