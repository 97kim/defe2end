import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactLimitError,
  MASKING_POLICY_VERSION,
  executionPlanSchema,
  isAbortReason,
  judgeRun,
  NO_STOP,
  stopCauseOfAbort,
  maskSecrets,
  SETTLE_AFTER_STEP_MS,
  STEP_MAX_ATTEMPTS,
  STEP_RETRY_DELAY_MS,
  stepDisplayName,
  stepTimeout,
  substituteVariables,
  type AbortReason,
  type ArtifactKind,
  type ArtifactSink,
  type ExecutionPlan,
  type RunErrorCode,
  type RunnerEvent,
  type RunVerdict,
  type Step,
  type StepOutcome,
  type StepResultStatus,
  type StopCause,
  splitSelectorList,
  type MaskingSettings,
  type VisualRuntime,
} from "@defe2end/shared";
import { captureA11ySnapshot } from "./a11y-snapshot.js";
import type { Locator, Page, Video } from "playwright";
import { ACTIONS, autoScroll, classify, scrollPlan, StepFailure, StepWarning, type ActionContext, type UploadFile } from "./actions.js";
import { launchBrowser, type RunBrowser } from "./browser.js";
import { BrowserLog } from "./browser-log.js";
import { domSummary } from "./dom-summary.js";
import { captureMasked, DEFAULT_MASKING, forceMask, MASKING_FAILED_MESSAGE, pageMaskScript } from "./masking.js";
import { hostResolverRules, isBlockedUrl } from "./network.js";
import { RunSession } from "./session.js";
import { collectRenderConditions } from "./render-conditions.js";
import { judgeScreenshot, type VisualRegressionOptions } from "./visual-regression.js";

export interface RunPlanOptions {
  sink: ArtifactSink;
  /** Awaited in order; text in events is already masked. */
  onEvent(event: RunnerEvent): void | Promise<void>;
  /** Stops the run from outside the step loop; `signal.reason` is an `AbortReason`. */
  signal: AbortSignal;
  /** Marks the browser process so `sweepBrowsers` can find it after a crash (the worker passes its pid). */
  owner: string;
  /** Chromium sandbox. Turn off only where the host can't provide it, and say so. */
  sandbox: boolean;
  /** Browser binary to launch instead of Playwright's installed one (the desktop app ships its own). */
  executablePath?: string;
  /** Default true (the worker). The desktop app shows the browser window unless its setting hides it. */
  headless?: boolean;
  /**
   * The desktop app (stage 4 contract 4.4.1): someone at the PC may close the browser window. A first page or
   * browser that goes away without the runner closing it then stops the run as `cancelled`, never retried.
   * Unset (the worker, no window): the same event is a crash and is judged as before.
   */
  userCanClose?: boolean;
  /** File for an `attachment:<name>` uploadFile token (the worker reads the version pinned in the snapshot); `undefined` fails the step. */
  resolveAttachment?(name: string): Promise<UploadFile | undefined>;
  /** Stage 7 section 4: judge passed screenshot steps against the pinned baselines. Unset = no visual regression. */
  visual?: VisualRegressionOptions;
  /**
   * Where this run executes, for the render conditions recorded with every passed screenshot step (stage 7
   * section 1): visual regression and environment comparison both need them. Defaults to `visual`'s.
   */
  render?: { runtime: VisualRuntime; imageFonts?: string };
  /** Stage 7 section 5: the run's masking settings (snapshot or app message). Absent = on, no site selectors. */
  masking?: MaskingSettings;
}

/** Not part of the public API: lets tests reach the loopback fixture server while private ranges are blocked. */
export interface RunInternals {
  hostAliases?: Record<string, string>;
  /** Hands tests the first page, e.g. to close it from outside like someone closing the window. */
  onFirstPage?(page: Page): void;
}

const STOPPED_STEP: Record<AbortReason, Pick<StepOutcome, "status" | "errorCode">> = {
  cancelled: { status: "cancelled", errorCode: "cancelled" },
  timed_out: { status: "timed_out", errorCode: "timed_out" },
  worker_lost: { status: "error", errorCode: "infra" },
  worker_shutdown: { status: "error", errorCode: "infra" },
};

const BLOCK_SERVICE_WORKERS = `(() => {
  const container = globalThis.ServiceWorkerContainer;
  if (!container) return;
  const refuse = () => Promise.reject(new DOMException("Service workers are blocked by the test runner", "SecurityError"));
  Object.defineProperty(container.prototype, "register", { value: refuse, writable: false, configurable: false });
})();`;

/** Attribute put on elements holding a secret so screenshot masks can find them by something we control. */
const SECRET_MARK = "data-defe2end-secret";
/** Errors of a handle whose document was navigated away or whose frame went away. */
const DOCUMENT_GONE = /Execution context was destroyed|Frame was detached|frame got detached/i;

const VARIABLE_KEYS = /\{\{([A-Za-z0-9_]+)\}\}/g;

/**
 * Runs one plan in its own browser process and returns the verdict. Knows nothing about the database or
 * storage: results leave through `onEvent` and the sink. The browser is closed — and its process group
 * confirmed gone — before this resolves.
 */
export function runPlan(plan: ExecutionPlan, opts: RunPlanOptions): Promise<RunVerdict> {
  return runPlanWith(plan, opts, {});
}

export async function runPlanWith(plan: ExecutionPlan, opts: RunPlanOptions, internals: RunInternals): Promise<RunVerdict> {
  // A caller on another version (stage 4 desktop app) must not get an option silently ignored. The issues
  // name paths only: values may be secrets.
  const valid = executionPlanSchema.safeParse(plan);
  if (!valid.success) {
    return { status: "error", errorCode: "internal", errorMessage: `Invalid execution plan: ${valid.error.issues.map((i) => i.path.join(".") || i.code).join(", ")}`, warningCount: 0 };
  }
  // A login session's cookie and localStorage values are credentials too. Values under 4 characters ("1",
  // "true") are left alone: they aren't credentials, and masking them would garble every message.
  const sessionValues = plan.storageState
    ? [...plan.storageState.cookies.map((c) => c.value), ...plan.storageState.origins.flatMap((o) => o.localStorage.map((e) => e.value))].filter((v) => v.length >= 4)
    : [];
  const secrets = [
    ...Object.values(plan.variables)
      .filter((v) => v.secret && v.value !== "")
      .map((v) => v.value),
    ...sessionValues,
  ];
  const mask = (text: string) => maskSecrets(text, secrets);
  const emit = async (event: RunnerEvent) => opts.onEvent(event);
  const log = (level: "info" | "warn" | "error", message: string, stepIndex?: number) =>
    emit({ type: "log", level, message: mask(message), ...(stepIndex === undefined ? {} : { stepIndex }) });
  // Contract 4.4.1: a window closed at the PC, told apart from the runner's own closing at the end.
  let closedByUser = false;
  let closingOurselves = false;
  let watched: { page: Page; connected: () => boolean } | undefined;
  const stopReason = (): AbortReason | undefined => {
    if (opts.signal.aborted) return isAbortReason(opts.signal.reason) ? opts.signal.reason : "cancelled";
    if (!closedByUser && watched && !closingOurselves && (watched.page.isClosed() || !watched.connected())) closedByUser = true;
    return closedByUser ? "cancelled" : undefined;
  };

  const attempt = plan.attempt ?? 1;
  const statuses: StepResultStatus[] = [];
  const skipRest = async (from: number) => {
    for (let i = from; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;
      statuses.push("skipped");
      await emit({
        type: "stepFinished",
        result: { index: i, stepId: step.id, action: step.action, name: stepDisplayName(step, i), status: "skipped", attempt, attempts: 0, startedAt: new Date().toISOString(), durationMs: 0 },
      });
    }
  };

  // Trace snapshots hold what was typed, so a run that puts a secret anywhere gets none (contract section 6).
  const usesSecrets = plan.steps.some((s) =>
    [s.selector, s.url, s.value, s.expected].some((text) => text !== undefined && [...text.matchAll(VARIABLE_KEYS)].some((m) => (Object.hasOwn(plan.variables, m[1]!) && plan.variables[m[1]!]!.secret))),
  );
  // A trace also holds the injected session's cookies, which can't be stripped from it.
  // Nor does a run with masking on: the trace's DOM copies can't be masked (stage 7 contract section 5).
  const masking = opts.masking ?? DEFAULT_MASKING;
  const recordTrace = plan.capture.traceOnFailure && !usesSecrets && !plan.storageState && !masking.enabled;
  if (plan.capture.video) await log("warn", "Video is on: it can't hide secrets or personal data");

  let browser: RunBrowser | undefined;
  if (!stopReason()) {
    try {
      browser = await launchBrowser({ owner: opts.owner, runId: plan.runId, sandbox: opts.sandbox, hostRules: hostResolverRules(plan.network, internals.hostAliases), ...(opts.executablePath ? { executablePath: opts.executablePath } : {}), ...(opts.headless === undefined ? {} : { headless: opts.headless }) });
    } catch (err) {
      await skipRest(0);
      return verdictFor(statuses, attempt, { type: "infra", code: "browser_launch_failed" }, firstLine(err), mask);
    }
  }
  if (!browser) {
    await skipRest(0);
    const reason = stopReason();
    return verdictFor(statuses, attempt, reason ? stopCauseOfAbort(reason) : NO_STOP);
  }
  const running = browser;
  const browserVersion = running.browser.version();
  const onAbort = () => void running.kill().catch(() => {});
  opts.signal.addEventListener("abort", onAbort, { once: true });

  let videoDir: string | undefined;
  let runError: { code: RunErrorCode; message: string } | undefined;
  // Fixed when the steps end: a cancel arriving while the browser closes doesn't overturn a finished result.
  let stopped: AbortReason | undefined;
  try {
    if (plan.capture.video) videoDir = await mkdtemp(join(tmpdir(), "defe2end-video-"));
    const context = await running.browser.newContext({
      viewport: plan.device.viewport,
      locale: plan.device.locale,
      timezoneId: plan.device.timezoneId,
      userAgent: plan.device.userAgent,
      // A service worker could answer requests without going through the block rules.
      serviceWorkers: "block",
      acceptDownloads: false,
      ...(videoDir ? { recordVideo: { dir: videoDir, size: plan.device.viewport } } : {}),
      // The login session goes into this context only; it is never logged or emitted.
      ...(plan.storageState ? { storageState: plan.storageState } : {}),
    });
    // `serviceWorkers: "block"` alone still lets a page register one in this setup (verified by the tests),
    // so registration is refused in every document as well. Traffic of a worker that got through anyway
    // still meets the resolver rules.
    await context.addInitScript(BLOCK_SERVICE_WORKERS);
    // Before the first navigation, so every page, popup and frame hides from its first paint on.
    await context.addInitScript(pageMaskScript(masking));
    if (recordTrace) await context.tracing.start({ screenshots: true, snapshots: true });
    const blockedLog: string[] = [];
    // Every page, frame and popup of the context. Redirect targets never reach this handler; the browser's
    // resolver rules (launchBrowser) refuse those, and both kinds end up in `requestfailed`.
    await context.route("**/*", async (route) => {
      if (isBlockedUrl(route.request().url(), plan.network)) await route.abort("blockedbyclient");
      else await route.continue();
    });
    // WebSockets get the same rule; allowed ones are passed through to the server unchanged.
    await context.routeWebSocket(/.*/, async (ws) => {
      if (isBlockedUrl(ws.url(), plan.network)) {
        blockedLog.push(ws.url());
        await ws.close({ code: 1008, reason: "Blocked by the runner" });
      } else ws.connectToServer();
    });
    context.on("requestfailed", (request) => {
      if (isBlockedUrl(request.url(), plan.network)) blockedLog.push(request.url());
    });
    const browserLog = new BrowserLog(secrets);
    const session = new RunSession(context, await context.newPage());
    browserLog.attach(context, () => session.currentIndex);
    internals.onFirstPage?.(session.mainPage);
    if (opts.userCanClose) {
      watched = { page: session.mainPage, connected: () => running.browser.isConnected() };
      let told = false;
      const closed = () => {
        if (told || closingOurselves || stopReason() !== "cancelled" || !closedByUser) return;
        told = true;
        void log("warn", "The browser window was closed, so the run was cancelled");
      };
      session.mainPage.once("close", closed);
      running.browser.once("disconnected", closed);
    }
    let maskPasses = 0;

    /**
     * Masks secret fields; records "not collected" with the reason instead of an unmasked image. When the page
     * masking can't be applied, a screenshot step fails and a failure screenshot is skipped (never unmasked).
     */
    const saveScreenshot = async (name: string, stepIndex: number, extraMask?: string, forStep = false) => {
      const page = session.active;
      const found = session.unmaskable.has(page) ? { reason: session.unmaskable.get(page)! } : await secretMasks(page);
      if ("reason" in found) {
        await log("warn", `Screenshot "${name}" not collected: ${found.reason}`, stepIndex);
        if (forStep) throw new MaskingRefused();
        return;
      }
      const shot = await captureMasked(page, { settings: masking, ...(extraMask ? { stepMask: extraMask } : {}), extra: found.masks });
      if (!shot.ok) {
        await log("warn", `Screenshot "${name}" not collected: masking could not be applied (${shot.reason})`, stepIndex);
        if (forStep) throw new MaskingRefused();
        return;
      }
      await storeBytes("screenshot", mask(name), shot.png, stepIndex);
      lastCapture = { bytes: shot.png, page };
    };
    /** The latest screenshot of the step in progress, for visual regression (stage 7 section 4). */
    let lastCapture: { bytes: Uint8Array; page: Page } | undefined;

    /**
     * A mask for every element on `page` that was given a secret. Each element still in the document gets a
     * mark of its own (again: the page may have dropped it), and the locator for that mark must resolve to
     * that very element. An element whose document is gone no longer shows the secret. Any element that
     * can't be confirmed this way means no screenshot.
     */
    const secretMasks = async (page: Page): Promise<{ masks: Locator[] } | { reason: string }> => {
      const masks = new Map<string, Locator>();
      const unconfirmed = { reason: "a field holding a secret could not be located for masking" };
      // Marks of one pass share a prefix, so an element given a secret twice keeps the mark it got first.
      const pass = `${++maskPasses}-`;
      for (const [i, { handle }] of session.secretFields.entries()) {
        if (session.secretFields[i]!.page !== page) continue;
        let mark: string | null;
        try {
          mark = await handle.evaluate(
            (el: Element, { attr, pass, id }) => {
              if (!el.isConnected) return null;
              const current = el.getAttribute(attr);
              if (current?.startsWith(pass)) return current;
              el.setAttribute(attr, pass + id);
              return pass + id;
            },
            { attr: SECRET_MARK, pass, id: String(i) },
          );
        } catch (err) {
          if (DOCUMENT_GONE.test(firstLine(err))) continue;
          return unconfirmed;
        }
        if (mark === null) continue;
        const owner = await handle.ownerFrame().catch(() => null);
        if (!owner) return unconfirmed;
        const marked = owner.locator(`[${SECRET_MARK}="${mark}"]`);
        const found = await marked.elementHandles().catch(() => []);
        let same = false;
        for (const other of found) {
          if (!same) same = await handle.evaluate((a, b) => a === b, other).catch(() => false);
          await other.dispose().catch(() => {});
        }
        if (!same) return unconfirmed;
        masks.set(mark, marked);
      }
      return { masks: [...masks.values()] };
    };

    const storeBytes = async (kind: ArtifactKind, name: string, bytes: Uint8Array, stepIndex?: number) => {
      const writer = await opts.sink.open({ kind, name, attempt, ...(stepIndex === undefined ? {} : { stepIndex }) });
      try {
        await writer.write(bytes);
      } catch (err) {
        await writer.abort(firstLine(err));
        throw err;
      }
      await emit({ type: "artifact", artifact: await writer.complete() });
    };

    /** A screenshot step's picture; a comparison child adds its accessibility snapshot right after. */
    const saveStepScreenshot = async (name: string, stepIndex: number, extraMask?: string, forStep = false) => {
      await saveScreenshot(name, stepIndex, extraMask, forStep);
      if (plan.a11ySnapshot) await saveA11ySnapshot(session.active, masking, secrets, extraMask, stepIndex, storeBytes, log);
    };

    /** Judges a passed screenshot step; a `changed`/`size_mismatch` makes it a warning, nothing here fails the run. */
    const judgeVisual = async (visual: VisualRegressionOptions, step: Step, index: number, capture: { bytes: Uint8Array; page: Page }, result: StepOutcome) => {
      const render = result.render;
      if (!render) {
        result.visualVerdict = "skipped";
        return;
      }
      const judged = await judgeScreenshot({ png: capture.bytes, render, pinned: visual.baselineFor(step.id), readBaseline: (id) => visual.readBaseline(id), ...(step.threshold === undefined ? {} : { tolerance: step.threshold }) });
      Object.assign(result, judged.fields);
      if (judged.diffPng) {
        try {
          await storeBytes("visual_diff", `step-${index + 1}-diff`, judged.diffPng, index);
        } catch (err) {
          if (err instanceof ArtifactLimitError) runError = { code: "artifact_limit", message: err.message };
          await log("warn", `Visual diff not collected: ${firstLine(err)}`, index);
        }
      }
      if (judged.warning) {
        result.status = "warning";
        result.errorCode = "warning";
        result.errorMessage = judged.warning;
      }
    };

    for (let index = 0; index < plan.steps.length; index++) {
      const step = plan.steps[index]!;
      if (stopReason()) {
        await skipRest(index);
        break;
      }
      const startedAt = new Date();
      session.currentIndex = index;
      await emit({ type: "stepStarted", index, stepId: step.id, action: step.action, startedAt: startedAt.toISOString() });
      lastCapture = undefined;
      const maskNow = async (page: Page) => {
        await forceMask(page, masking).catch(() => {});
        return secretMasks(page);
      };
      const outcome = await runStep(step, index, session, plan, opts, saveStepScreenshot, stopReason, (m) => log("info", m, index), () => blockedLog.length > 0, maskNow);
      if (outcome.limit) runError = { code: "artifact_limit", message: outcome.limit.message };

      // A screenshot refused for masking isn't captured again as a failure screenshot (without the step's mask).
      const refused = outcome.maskingRefused === true;
      if ((outcome.status === "failed" || outcome.status === "error") && !stopReason() && !runError && !refused) {
        // Try to capture the failure; record why when it can't be done (e.g. the browser died).
        try {
          await saveScreenshot(`step-${index + 1}-failure`, index);
        } catch (err) {
          if (err instanceof ArtifactLimitError) runError = { code: "artifact_limit", message: err.message };
          await log("warn", `Failure screenshot not collected: ${firstLine(err)}`, index);
        }
        // Masked page structure for the AI diagnosis (stage 6 contract section 8). Made even when the run uses
        // secrets (unlike a trace): it holds no input values and is masked with the run's secret values.
        if (!runError) {
          try {
            const summary = await domSummary(session.active, step.selector ?? null, secrets);
            await storeBytes("dom_summary", `step-${index + 1}-dom`, new TextEncoder().encode(summary), index);
          } catch (err) {
            if (err instanceof ArtifactLimitError) runError = { code: "artifact_limit", message: err.message };
            await log("warn", `DOM summary not collected: ${firstLine(err)}`, index);
          }
        }
      }
      for (const url of blockedLog.splice(0)) await log("warn", `Blocked request to ${url}`, index);
      // The page's console errors and failed requests of this step, already masked (stage 6 contract section 8).
      const consoleText = runError ? null : browserLog.take(index);
      if (consoleText) {
        try {
          await storeBytes("log", `step-${index + 1}-console`, new TextEncoder().encode(consoleText), index);
        } catch (err) {
          if (err instanceof ArtifactLimitError) runError = { code: "artifact_limit", message: err.message };
          await log("warn", `Browser log not collected: ${firstLine(err)}`, index);
        }
      }

      const result: StepOutcome = {
        index,
        stepId: step.id,
        action: step.action,
        name: mask(stepDisplayName(step, index)),
        status: outcome.status,
        attempt,
        attempts: outcome.attempts,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
      };
      if (outcome.attempts > 1) result.retried = true;
      // Set inside the screenshot callback; TypeScript can't see that assignment here.
      const capture = lastCapture as { bytes: Uint8Array; page: Page } | undefined;
      if (step.action === "screenshot" && outcome.status === "passed" && capture && !runError) {
        // Render conditions of every capture, apart from the visual verdict (comparisons need them too).
        const where = opts.render ?? opts.visual;
        if (where) {
          try {
            const r = await collectRenderConditions(capture.page, { runtime: where.runtime, maskPolicyVersion: MASKING_POLICY_VERSION, browserVersion, ...(where.imageFonts ? { imageFonts: where.imageFonts } : {}) });
            result.render = { browserVersion: r.browserVersion, deviceScaleFactor: r.deviceScaleFactor, viewport: r.viewport, fontSet: r.fontSet, maskingPolicyVersion: Number(r.maskPolicyVersion) };
          } catch (err) {
            await log("warn", `Render conditions not recorded: ${firstLine(err)}`, index);
          }
        }
        // Never in an environment comparison child (contract section 6): it only captures.
        if (opts.visual && !plan.a11ySnapshot) await judgeVisual(opts.visual, step, index, capture, result);
      }
      if (outcome.failure) {
        if (outcome.failure.code) result.errorCode = outcome.failure.code;
        result.errorMessage = mask(outcome.failure.message);
        if (outcome.failure.detail.expected !== undefined) result.expected = mask(outcome.failure.detail.expected);
        if (outcome.failure.detail.actual !== undefined) result.actual = mask(outcome.failure.detail.actual);
      }
      statuses.push(result.status);
      await emit({ type: "stepFinished", result });

      const keepGoing = result.status === "passed" || result.status === "warning" || result.status === "skipped";
      if (!keepGoing || runError) {
        await skipRest(index + 1);
        break;
      }
    }
    stopped = stopReason();
    // From here on the runner closes pages and the browser itself.
    closingOurselves = true;
    if (!running.browser.isConnected() && !stopped && !runError && statuses.includes("error")) {
      runError = { code: "browser_crashed", message: "The browser process ended unexpectedly" };
    }

    // Trace and video need a live browser; a stopped run doesn't wait for them.
    const alive = running.browser.isConnected() && !stopReason();
    if (recordTrace) {
      const failed = runError !== undefined || statuses.includes("failed") || statuses.includes("error");
      if (alive && failed) {
        const dir = await mkdtemp(join(tmpdir(), "defe2end-trace-"));
        try {
          const path = join(dir, "trace.zip");
          await context.tracing.stop({ path });
          await storeFile("trace", "trace", path);
        } catch (err) {
          if (err instanceof ArtifactLimitError) runError ??= { code: "artifact_limit", message: err.message };
          else await log("warn", `Trace not collected: ${firstLine(err)}`);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      } else if (alive) await context.tracing.stop().catch(() => {});
      else if (failed) await log("warn", "Trace not collected: the browser was no longer running");
    }
    if (videoDir) {
      if (alive) {
        const videos = [...new Set([session.mainPage, ...session.opened.map((o) => o.page)])].map((page) => page.video()).filter((v): v is Video => v !== null);
        await context.close();
        for (const [i, video] of videos.entries()) {
          try {
            // The browser runs as a server we connect to, so the file is fetched with saveAs, not path().
            const path = join(videoDir, `saved-${i}.webm`);
            await video.saveAs(path);
            await storeFile("video", videos.length > 1 ? `video-${i + 1}` : "video", path);
          } catch (err) {
            if (err instanceof ArtifactLimitError) runError ??= { code: "artifact_limit", message: err.message };
            else await log("warn", `Video not collected: ${firstLine(err)}`);
          }
        }
      } else await log("warn", "Video not collected: the run was stopped or the browser was no longer running");
    }
  } catch (err) {
    // Setup trouble (context, routing) or an event the caller refused: infrastructure, not a test failure.
    stopped = stopReason();
    closingOurselves = true;
    if (!stopped) runError = { code: "internal", message: firstLine(err) };
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
    await (stopReason() ? running.kill() : running.close());
    if (videoDir) await rm(videoDir, { recursive: true, force: true });
  }

  // A stop from outside wins over a run error and carries no message.
  if (stopped) return { ...verdictFor(statuses, attempt, stopCauseOfAbort(stopped)), browserVersion };
  return { ...verdictFor(statuses, attempt, runError ? { type: "infra", code: runError.code } : NO_STOP, runError?.message, mask), browserVersion };

  /** Streams a file to the sink in chunks. */
  async function storeFile(kind: ArtifactKind, name: string, path: string): Promise<void> {
    const writer = await opts.sink.open({ kind, name, attempt });
    try {
      for await (const chunk of createReadStream(path)) await writer.write(chunk as Buffer);
    } catch (err) {
      await writer.abort(firstLine(err));
      throw err;
    }
    await emit({ type: "artifact", artifact: await writer.complete() });
  }
}

/** The verdict of this attempt through the shared judge, so the rule lives in one place (`judgeRun`). */
function verdictFor(statuses: StepResultStatus[], attempt: number, stopCause: StopCause, message?: string, mask: (text: string) => string = (t) => t): RunVerdict {
  const { status, errorCode, warningCount } = judgeRun(statuses.map((s) => ({ attempt, status: s })), stopCause);
  const verdict: RunVerdict = { status, warningCount };
  if (errorCode) verdict.errorCode = errorCode;
  if (errorCode && message !== undefined) verdict.errorMessage = mask(message);
  return verdict;
}

async function runStep(
  step: Step,
  index: number,
  session: RunSession,
  plan: ExecutionPlan,
  opts: RunPlanOptions,
  saveScreenshot: (name: string, stepIndex: number, extraMask?: string, forStep?: boolean) => Promise<void>,
  stopReason: () => AbortReason | undefined,
  log: (message: string) => Promise<void>,
  /** Whether a request was blocked during this step (redirect targets only show up this way). */
  sawBlocked: () => boolean,
  /** One masking pass over `page` (spec 2.11). */
  maskNow: (page: Page) => Promise<unknown>,
): Promise<{ status: StepResultStatus; attempts: number; failure?: StepFailure; limit?: ArtifactLimitError; maskingRefused?: boolean }> {
  const action = ACTIONS[step.action];
  if (!action) return { status: "error", attempts: 0, failure: new StepFailure("unsupported_action", `The ${step.action} action is not supported by this runner`, {}, "error") };

  const fields: Partial<Record<"selector" | "url" | "value" | "expected", { text: string; secrets: string[] }>> = {};
  for (const key of ["selector", "url", "value", "expected"] as const) {
    const raw = step[key];
    if (raw === undefined) continue;
    const sub = substituteVariables(raw, plan.variables);
    if (!sub.ok) return { status: "failed", attempts: 0, failure: new StepFailure(sub.code, `Secret has no value: ${sub.key}`) };
    fields[key] = sub;
  }

  // The plan's default stands in for 30000 ms (spec 2.1); `wait` defaults to 1000 ms.
  const timeoutMs = step.timeout ?? (step.action === "wait" ? stepTimeout(step) : plan.stepTimeoutMs);
  // Optional steps run once; others get one more try after a pause (spec 2.9).
  const maxAttempts = step.optional ? 1 : STEP_MAX_ATTEMPTS;
  let failure: StepFailure | undefined;
  // Carried apart from `failure`, so no reclassification below can drop it (no failure screenshot then).
  let maskingRefused = false;
  let attempts = 0;
  while (attempts < maxAttempts) {
    if (attempts > 0) {
      await new Promise((r) => setTimeout(r, STEP_RETRY_DELAY_MS));
      if (stopReason()) break;
    }
    attempts++;
    const ctx: ActionContext = {
      session,
      step,
      index,
      baseUrl: plan.baseUrl,
      network: plan.network,
      timeoutMs,
      selector: fields.selector?.text,
      url: fields.url?.text,
      value: fields.value?.text,
      expected: fields.expected?.text,
      valueHasSecret: (fields.value?.secrets.length ?? 0) + (fields.expected?.secrets.length ?? 0) > 0,
      signal: opts.signal,
      screenshot: async () => {
        await settle(session);
        await saveScreenshot(step.name || `step-${index + 1}`, index, step.mask, true);
      },
      maskBeforeInput: async (page) => {
        await maskNow(page).catch(() => {});
      },
      log,
      resolveAttachment: opts.resolveAttachment,
    };
    try {
      // Auto-scroll (spec 2.10); quick, without waiting, for optional steps and assertVisibleOrWarn.
      const scroll = scrollPlan(step, ctx.selector);
      const quick = step.optional === true || step.action === "assertVisibleOrWarn";
      const scrolled = scroll.before && (await autoScroll(ctx, quick));
      await action(ctx);
      if (scroll.after === "always") await autoScroll(ctx, quick);
      else if (scroll.after === "if-missed" && !scrolled) await autoScroll(ctx, true);
      // Settle after a successful step, except `wait` (spec 2.2). `screenshot` settled before taking the picture.
      if (step.action !== "wait" && step.action !== "screenshot") await settle(session);
      return { status: "passed", attempts };
    } catch (err) {
      const stopped = stopReason();
      if (stopped) return { ...STOPPED_STEP[stopped], attempts, failure: new StepFailure(STOPPED_STEP[stopped].errorCode, stoppedMessage(stopped)) };
      if (err instanceof ArtifactLimitError) return { status: "error", attempts, failure: new StepFailure("infra", err.message, {}, "error"), limit: err };
      if (err instanceof StepWarning) return { status: "warning", attempts, failure: new StepFailure("warning", err.message) };
      failure = classify(err);
      // Kept over every try of the step: a refusal once means no failure screenshot, whatever the retry did.
      if (err instanceof MaskingRefused) {
        maskingRefused = true;
        continue;
      }
      // A navigation that failed because a request in it (e.g. a redirect target) was blocked: a safety block,
      // so neither retried nor turned into `skipped` by optional.
      if (failure.status === "failed" && !failure.code && sawBlocked()) failure = new StepFailure("blocked_request", failure.message);
      if (failure.status === "error" && session.context.browser()?.isConnected() && session.mainPage.isClosed()) {
        failure = new StepFailure(undefined, "The first page was closed");
      }
      // Infrastructure trouble and safety blocks are not retried.
      if (failure.status === "error" || failure.code === "blocked_request" || failure.code === "missing_secret") break;
    }
  }
  // Optional: an action failure becomes `skipped`; safety blocks and infrastructure stay what they are.
  if (step.optional && failure && failure.status === "failed" && failure.code !== "blocked_request") {
    return { status: "skipped", attempts, failure: new StepFailure(failure.code, `[optional] ${failure.message}`, failure.detail), ...(maskingRefused ? { maskingRefused } : {}) };
  }
  return { status: failure!.status, attempts, failure, ...(maskingRefused ? { maskingRefused } : {}) };
}

async function settle(session: RunSession): Promise<void> {
  await new Promise((r) => setTimeout(r, SETTLE_AFTER_STEP_MS));
  void session;
}

function stoppedMessage(reason: AbortReason): string {
  switch (reason) {
    case "cancelled":
      return "Cancelled while this step was running";
    case "timed_out":
      return "The run hit its overall time limit during this step";
    case "worker_lost":
      return "The worker lost its lease during this step";
    case "worker_shutdown":
      return "The worker shut down during this step";
  }
}

/** A screenshot step whose masking couldn't be applied: failed, nothing captured, no failure screenshot. */
class MaskingRefused extends StepFailure {
  constructor() {
    super(undefined, MASKING_FAILED_MESSAGE);
  }
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
}

/** Comparison child: the masked accessibility snapshot right after the screenshot; none when masking fails. */
async function saveA11ySnapshot(
  page: Page,
  masking: MaskingSettings,
  secrets: Iterable<string>,
  stepMask: string | undefined,
  index: number,
  store: (kind: ArtifactKind, name: string, bytes: Uint8Array, stepIndex?: number) => Promise<void>,
  log: (level: "info" | "warn" | "error", message: string, stepIndex?: number) => Promise<void>,
): Promise<void> {
  // Same targets as the screenshot: site selectors while the scenario keeps masking on, and the step's mask.
  const selectors = [...(masking.enabled ? masking.selectors : []), ...splitSelectorList(stepMask ?? "")];
  // `secrets` already holds the session's values.
  const result = await captureA11ySnapshot(page, { selectors, secrets });
  if (!result.ok) {
    await log("warn", `Structure snapshot not collected: ${result.reason}`, index);
    return;
  }
  await store("a11y_snapshot", `step-${index + 1}`, new TextEncoder().encode(result.text), index);
}
