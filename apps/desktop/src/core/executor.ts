// PC runs (stage 4 contract section 4, desktop spec 2): queue, start ACK, lease heartbeat, runner, completion.
import { Buffer } from "node:buffer";
import { runWithRetries, type RunPlanOptions, type UploadFile } from "@defe2end/runner";
import {
  DESKTOP_MAX_CONCURRENCY,
  DESKTOP_TIMINGS,
  desktopHeartbeatResponseSchema,
  desktopStartResponseSchema,
  isTerminalRunStatus,
  judgeRun,
  type AbortReason,
  type DesktopCompleteRequest,
  type DesktopRunMessage,
  type ExecutionPlan,
  type RunnerEvent,
  type RunVerdict,
  type StepOutcome,
  type StopCause,
} from "@defe2end/shared";
import { HttpError, readBody, type DesktopApi } from "./api-client.js";
import { uploadSink } from "./artifact-sink.js";
import type { GenerationTicket } from "./generation.js";
import type { Owner } from "./outbox.js";

/** Start ACK retries: a burst of immediate, 0.5 s, 1.5 s, then 5, 15, 60, 60… seconds between bursts. */
export const START_BURST_MS = [0, 500, 1_500] as const;
export const START_BACKOFF_MS = [5_000, 15_000, 60_000] as const;
/** After losing the lease the browser must be gone within this. */
export const LOST_STOP_MS = 10_000;

export type RunPhase = "queued" | "starting" | "running" | "reporting" | "done";

export interface RunProgress {
  runId: string;
  phase: RunPhase;
  event?: RunnerEvent;
  verdict?: RunDone;
}

export type RunDone = { status: DesktopCompleteRequest["verdict"] } | { dropped: "cancelled_before_start" | "not_ours" | "ended_on_server" | "ownership_lost" };

export interface ExecutorOptions {
  api: Pick<DesktopApi, "request" | "json">;
  ticket: GenerationTicket;
  owner(): Owner | null;
  /** Stores and sends the completion (Outbox.add). */
  report(runId: string, owner: Owner, body: DesktopCompleteRequest, secrets: readonly string[]): Promise<void>;
  /** Completions still waiting in the outbox; new runs wait while any exist (back-pressure). */
  pendingReports(): number;
  runPlan(plan: ExecutionPlan, opts: RunPlanOptions): Promise<RunVerdict>;
  /** Browser process mark (`sweepBrowsers`). */
  ownerMark: string;
  sandbox: boolean;
  /** The packaged app's own Chromium; unset = Playwright's installed one (development). */
  executablePath?: string;
  /** Read when each run starts: the app's "hide the browser" setting (contract 4.4.1). Default false = visible. */
  headless?(): boolean;
  onProgress?(progress: RunProgress): void;
  log?(message: string): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** Monotonic clock in ms (default `performance.now`). */
  now?(): number;
}

interface Job {
  message: DesktopRunMessage;
  phase: RunPhase;
  /** Cancels the start retries, or stops the runner (`reason` is an `AbortReason`). */
  controller: AbortController;
  claimToken?: string;
  /**
   * Monotonic deadline of the lease (`now()` clock): the server's `leaseRemainingMs` counted from when the
   * request that got it was sent, so neither a PC clock that is off nor a slow answer can stretch it.
   */
  leaseDeadline?: number;
  lost: boolean;
  /** Heartbeat keeps going until the completion is accepted (`settled`). */
  heartbeat?: ReturnType<typeof setInterval>;
  watchdog?: ReturnType<typeof setTimeout>;
  settled: boolean;
  /** The server asked to cancel (heartbeat). */
  cancelRequested?: boolean;
}

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Secret values the runner masks; the completion is masked with the same list before it touches disk. */
export function planSecrets(plan: ExecutionPlan): string[] {
  const session = plan.storageState
    ? [...plan.storageState.cookies.map((c) => c.value), ...plan.storageState.origins.flatMap((o) => o.localStorage.map((e) => e.value))].filter((v) => v.length >= 4)
    : [];
  return [...Object.values(plan.variables).filter((v) => v.secret && v.value !== "").map((v) => v.value), ...session];
}

/**
 * The app's run queue. Runs start in arrival order: one at a time, or up to a group's `concurrency` (at most
 * 4) for its children. Each run number gets one browser at most, whatever the server sends again.
 */
export class RunExecutor {
  private readonly jobs = new Map<string, Job>();
  /** Every run number seen in this generation: a repeated `run` message never launches a second browser. */
  private readonly seen = new Set<string>();
  private readonly queue: string[] = [];
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly opts: ExecutorOptions) {
    this.sleep = opts.sleep ?? sleepFor;
    this.now = opts.now ?? (() => performance.now());
  }

  /** Queued and running runs (`Defe2end-Active-Runs`, together with the outbox). */
  activeRunIds(): string[] {
    return [...this.jobs.values()].filter((j) => j.phase !== "done" && !j.lost).map((j) => j.message.runId);
  }

  enqueue(message: DesktopRunMessage): void {
    if (this.closed || this.seen.has(message.runId)) return;
    this.seen.add(message.runId);
    this.jobs.set(message.runId, { message, phase: "queued", controller: new AbortController(), lost: false, settled: false });
    this.queue.push(message.runId);
    this.progress(message.runId, "queued");
    this.pump();
  }

  /** `stop-run`: a queued run just leaves (the server already cancelled it); a running one is stopped. Unknown ids are ignored. */
  stop(runId: string): void {
    const job = this.jobs.get(runId);
    if (!job || job.phase === "done" || job.phase === "reporting") return;
    job.controller.abort("cancelled" satisfies AbortReason);
    if (job.phase === "queued") {
      this.queue.splice(this.queue.indexOf(runId), 1);
      this.finish(job, { dropped: "cancelled_before_start" });
    }
  }

  /** The completion of `runId` was accepted or quarantined: stop its heartbeat. */
  settled(runId: string): void {
    const job = this.jobs.get(runId);
    if (!job) return;
    job.settled = true;
    this.stopLease(job);
  }

  /** Re-check the queue (the outbox drained). */
  pump(): void {
    while (!this.closed && this.queue.length > 0) {
      const head = this.jobs.get(this.queue[0]!)!;
      const limit = head.message.groupRunId ? Math.min(head.message.concurrency, DESKTOP_MAX_CONCURRENCY) : 1;
      const busy = [...this.jobs.values()].filter((j) => j.phase === "starting" || j.phase === "running").length;
      const reporting = [...this.jobs.values()].some((j) => j.phase === "reporting");
      if (busy >= limit || reporting || this.opts.pendingReports() > 0) return;
      this.queue.shift();
      void this.execute(head).catch((err) => this.opts.log?.(`run ${head.message.runId}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /** Generation change or quit: stop everything, wait for the browsers up to `budgetMs`. Nothing more is reported. */
  async shutdown(budgetMs = 5_000): Promise<void> {
    this.closed = true;
    const running: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      job.lost = true;
      this.stopLease(job);
      job.controller.abort("worker_shutdown" satisfies AbortReason);
      if (job.phase === "running") running.push(new Promise((r) => job.controller.signal.addEventListener("finished", () => r(), { once: true })));
    }
    this.queue.length = 0;
    await Promise.race([Promise.all(running), new Promise((r) => setTimeout(r, budgetMs))]);
  }

  private progress(runId: string, phase: RunPhase, extra: Partial<RunProgress> = {}): void {
    if (this.opts.ticket.current()) this.opts.onProgress?.({ runId, phase, ...extra });
  }

  private finish(job: Job, verdict: RunDone): void {
    job.phase = "done";
    if (!("status" in verdict)) this.stopLease(job);
    this.progress(job.message.runId, "done", { verdict });
    job.controller.signal.dispatchEvent(new Event("finished"));
    this.pump();
  }

  private stopLease(job: Job): void {
    if (job.heartbeat) clearInterval(job.heartbeat);
    if (job.watchdog) clearTimeout(job.watchdog);
    job.heartbeat = job.watchdog = undefined;
  }

  private path(job: Job, suffix: string): string {
    return `/api/desktop/runs/${encodeURIComponent(job.message.runId)}/${suffix}`;
  }

  /** `POST …/start` until the server answers. Null: the run is not ours to run. */
  private async start(job: Job): Promise<RunDone | null> {
    const signal = job.controller.signal;
    for (let round = 0; !signal.aborted && this.opts.ticket.current(); round++) {
      if (round > 0) await this.sleep(START_BACKOFF_MS[Math.min(round - 1, START_BACKOFF_MS.length - 1)]!, signal);
      for (const delay of START_BURST_MS) {
        if (delay) await this.sleep(delay, signal);
        if (signal.aborted || !this.opts.ticket.current()) break;
        try {
          const sentAt = this.now();
          const res = await this.opts.api.request(this.path(job, "start"), { method: "POST", headers: { "Idempotency-Key": `run-start-${job.message.runId}` } });
          const body = await readBody(res);
          if (res.status === 404) return { dropped: "not_ours" };
          if (!res.ok) throw new HttpError(res.status, body);
          const parsed = desktopStartResponseSchema.parse(body);
          if (isTerminalRunStatus(parsed.status)) return { dropped: "ended_on_server" };
          if (parsed.status === "running" && parsed.claimToken) {
            job.claimToken = parsed.claimToken;
            if (parsed.leaseRemainingMs !== undefined) {
              job.leaseDeadline = sentAt + parsed.leaseRemainingMs;
              return null;
            }
            // An older server doesn't say how much is left (a repeated start keeps the old lease): renew it
            // once before the browser starts, so the deadline is known.
            const renewed = await this.renew(job);
            if (renewed === "lost") return { dropped: "ownership_lost" };
            if (renewed === "ok") return null;
          }
          // Still queued (a group condition): ask again later.
        } catch (err) {
          this.opts.log?.(`run ${job.message.runId}: start not acknowledged (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
    return { dropped: signal.aborted ? "cancelled_before_start" : "ownership_lost" };
  }

  private loseOwnership(job: Job, why: string): void {
    if (job.lost) return;
    job.lost = true;
    this.opts.log?.(`run ${job.message.runId}: ownership lost (${why}), stopping`);
    this.stopLease(job);
    job.controller.abort("worker_lost" satisfies AbortReason);
  }

  private armWatchdog(job: Job): void {
    if (job.watchdog) clearTimeout(job.watchdog);
    const left = job.leaseDeadline! - DESKTOP_TIMINGS.leaseSafetyMs - this.now();
    // An ended run has nothing to stop; the outbox keeps resending on its own.
    job.watchdog = setTimeout(() => {
      if (job.phase === "running") this.loseOwnership(job, "lease could not be renewed");
    }, Math.max(0, left));
  }

  private startLease(job: Job): void {
    this.armWatchdog(job);
    job.heartbeat = setInterval(() => void this.beat(job), DESKTOP_TIMINGS.runHeartbeatMs);
  }

  /** One heartbeat: `ok` sets the deadline, `lost` = 404/409, `unknown` = no answer. */
  private async renew(job: Job): Promise<"ok" | "lost" | "unknown"> {
    try {
      const sentAt = this.now();
      const res = await this.opts.api.request(this.path(job, "heartbeat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: () => JSON.stringify({ claimToken: job.claimToken }),
      });
      const body = await readBody(res);
      if (res.status === 404 || res.status === 409) return "lost";
      if (!res.ok) return "unknown";
      const hb = desktopHeartbeatResponseSchema.parse(body);
      job.leaseDeadline = sentAt + hb.leaseRemainingMs;
      job.cancelRequested ||= hb.cancelRequested;
      return "ok";
    } catch {
      return "unknown";
    }
  }

  private async beat(job: Job): Promise<void> {
    if (job.lost || job.settled || !this.opts.ticket.current()) return;
    const result = await this.renew(job);
    if (job.lost) return;
    if (result === "lost") {
      // `lease_lost`, or the run ended (it was finalized elsewhere): either way it's no longer ours.
      if (job.phase === "running") this.loseOwnership(job, "heartbeat refused");
      else this.stopLease(job);
      return;
    }
    // No answer: the watchdog stops the run before the last known deadline.
    if (result === "ok") this.armWatchdog(job);
    if (job.cancelRequested && job.phase === "running") job.controller.abort("cancelled" satisfies AbortReason);
  }

  private async execute(job: Job): Promise<void> {
    const { message } = job;
    job.phase = "starting";
    this.progress(message.runId, "starting");
    const dropped = await this.start(job);
    if (dropped) return this.finish(job, dropped);
    const owner = this.opts.owner();
    if (!owner || !this.opts.ticket.current()) return this.finish(job, { dropped: "ownership_lost" });

    job.phase = "running";
    this.progress(message.runId, "running");
    this.startLease(job);
    if (job.cancelRequested) job.controller.abort("cancelled" satisfies AbortReason);
    const signal = job.controller.signal;
    const steps: StepOutcome[] = [];
    const startedAt = Date.now();
    const sink = uploadSink({ api: this.opts.api, runId: message.runId, claimToken: job.claimToken!, onOwnershipLost: () => this.loseOwnership(job, "artifact upload refused") });
    // One setting per run, so every attempt of it looks the same.
    const headless = this.opts.headless?.() ?? false;
    const plan: ExecutionPlan = { ...message.plan, capture: { video: message.policy.video, traceOnFailure: message.policy.traceOnFailure }, ...(message.comparison ? { a11ySnapshot: true } : {}) };

    const onEvent = (event: RunnerEvent) => {
      if (job.lost) return;
      if (event.type === "stepFinished") steps.push(event.result);
      this.progress(message.runId, "running", { event });
      const live =
        event.type === "stepStarted" ? { type: "stepStarted" as const, attempt: currentAttempt, index: event.index, stepId: event.stepId, action: event.action, startedAt: event.startedAt } : event.type === "stepFinished" ? event : null;
      if (live) void this.postSteps(job, live);
    };
    let currentAttempt = 1;

    let stopCause: StopCause;
    let attemptCount = 1;
    let passedAfterRetry = false;
    try {
      const retried = await runWithRetries({
        policy: { maxAttempts: message.policy.retryAttempts, retryOnFailure: true, runTimeoutMs: message.policy.runTimeoutMs },
        startedAt,
        signal,
        stop: (reason) => job.controller.abort(reason),
        runAttempt: (attempt) => {
          currentAttempt = attempt;
          return this.opts.runPlan({ ...plan, attempt }, {
            headless,
            // Someone at this PC may close the browser window: that is a cancel, not a failure (contract 4.4.1).
            userCanClose: true, sink, onEvent, signal, owner: this.opts.ownerMark, sandbox: this.opts.sandbox, ...(this.opts.executablePath ? { executablePath: this.opts.executablePath } : {}), resolveAttachment: (name) => this.attachment(job, name, signal), ...(message.masking ? { masking: message.masking } : {}) });
        },
      });
      ({ stopCause, attemptCount, passedAfterRetry } = retried);
    } catch (err) {
      this.opts.log?.(`run ${message.runId}: runner failed (${err instanceof Error ? err.message : String(err)})`);
      stopCause = { type: "infra", code: "internal" };
      attemptCount = currentAttempt;
    }

    if (job.lost || !this.opts.ticket.current()) return this.finish(job, { dropped: "ownership_lost" });
    job.phase = "reporting";
    const verdict = judgeRun(steps, stopCause).status;
    const body: DesktopCompleteRequest = { claimToken: job.claimToken!, verdict, stopCause, attemptCount, passedAfterRetry, durationMs: Date.now() - startedAt, steps };
    // The heartbeat keeps the lease alive until the outbox reports the completion settled.
    try {
      await this.opts.report(message.runId, owner, body, planSecrets(message.plan));
    } finally {
      this.finish(job, { status: verdict });
    }
  }

  /** `attachment:<name>` of uploadFile: the version pinned in the `run` message, fetched from the server. */
  private async attachment(job: Job, name: string, signal: AbortSignal): Promise<UploadFile | undefined> {
    const pinned = job.message.attachments.find((a) => a.name === name);
    if (!pinned) return undefined;
    try {
      const res = await this.opts.api.request(this.path(job, `attachments/${encodeURIComponent(pinned.id)}`), { signal, timeoutMs: 60_000 });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        this.opts.log?.(`run ${job.message.runId}: attachment ${pinned.id} HTTP ${res.status}`);
        return undefined;
      }
      return { name: pinned.name, mimeType: pinned.contentType, buffer: Buffer.from(await res.arrayBuffer()) };
    } catch (err) {
      this.opts.log?.(`run ${job.message.runId}: attachment ${pinned.id} failed (${err instanceof Error ? err.message : String(err)})`);
      return undefined;
    }
  }

  private async postSteps(job: Job, event: unknown): Promise<void> {
    try {
      const res = await this.opts.api.request(this.path(job, "steps"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: () => JSON.stringify({ claimToken: job.claimToken, events: [event] }),
      });
      await res.body?.cancel().catch(() => {});
      if (res.status === 404 || res.status === 409) this.loseOwnership(job, `step report HTTP ${res.status}`);
    } catch {
      // Best effort: the completion carries every step again.
    }
  }
}
