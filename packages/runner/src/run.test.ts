// Real Chromium against the fixture pages through the public runPlan.
import { spawn } from "node:child_process";
import type { ExecutionPlan, RunnerEvent, Step } from "@defe2end/shared";
import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { launchBrowser } from "./browser.js";
import { runPlanWith } from "./run.js";
import { listMarkedBrowsers, runPlan, runWithRetries, sweepBrowsers } from "./index.js";
import { boxOf, makePlan, memorySink, noBrowserLeftFor, pixelAt, SANDBOX, SECRET, useFixtures } from "./test-support.js";

const fixtures = useFixtures();
const plan = (steps: Step[], variables: ExecutionPlan["variables"] = {}) => makePlan(fixtures.url, steps, { variables });

async function run(p: ExecutionPlan, signal = new AbortController().signal) {
  const events: RunnerEvent[] = [];
  const { sink, files } = memorySink();
  const verdict = await runPlan(p, { sink, signal, owner: String(process.pid), sandbox: SANDBOX, onEvent: (e) => void events.push(e) });
  const results = events.flatMap((e) => (e.type === "stepFinished" ? [e.result] : []));
  return { verdict, events, results, files };
}

describe("runPlan", () => {
  it("passes a login flow and takes a screenshot", async () => {
    const p = plan([
      { id: "s1", action: "goto", url: "/login.html" },
      { id: "s2", action: "fill", selector: "[data-testid=username]", value: "{{USER}}" },
      { id: "s3", action: "fill", selector: "[data-testid=password]", value: "{{PASSWORD}}" },
      { id: "s4", action: "click", selector: "[data-testid=login-submit]" },
      { id: "s5", action: "assertText", selector: "h1", expected: "Products" },
      { id: "s6", action: "screenshot", name: "after login" },
    ], { USER: { value: "tester", secret: false }, PASSWORD: { value: "correct-horse", secret: true } });
    const { verdict, results, files } = await run(p);
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "passed", "passed", "passed"]);
    expect(verdict.status).toBe("passed");
    expect(verdict.browserVersion).toMatch(/^\d+\./);
    expect(files.map((f) => f.name)).toEqual(["after login"]);
    expect(files[0]!.bytes.subarray(1, 4).toString()).toBe("PNG");
    await noBrowserLeftFor(p.runId);
  });

  it("fails an assertion with masked expected and actual, captures the failure, skips the rest", async () => {
    const p = plan([
      { id: "s1", action: "goto", url: "/login.html" },
      { id: "s2", action: "fill", selector: "[data-testid=username]", value: "{{TOKEN}}" },
      { id: "s3", action: "assertText", selector: "h1", expected: "Welcome {{TOKEN}}", timeout: 500 },
      { id: "s4", action: "click", selector: "[data-testid=login-submit]" },
    ], { TOKEN: { value: SECRET, secret: true } });
    const { verdict, results, files, events } = await run(p);
    expect(verdict.status).toBe("failed");
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "failed", "skipped"]);
    expect(results[2]).toMatchObject({ errorCode: "assertion_failed", attempts: 2, expected: "Welcome ••••••", actual: "Log in" });
    expect(files.map((f) => f.name)).toEqual(["step-3-failure", "step-3-dom"]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("masks inputs filled with a secret in screenshots", async () => {
    const p = plan([
      { id: "s1", action: "goto", url: "/login.html" },
      { id: "s2", action: "fill", selector: "[data-testid=username]", value: "{{TOKEN}}" },
      { id: "s3", action: "screenshot", name: "form" },
    ], { TOKEN: { value: SECRET, secret: true } });
    const { verdict, files } = await run(p);
    expect(verdict.status).toBe("passed");
    // Playwright paints masks magenta.
    const box = await boxOf(`${fixtures.url}/login.html`, "[data-testid=username]");
    expect(await pixelAt(files[0]!.bytes, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2))).toEqual([255, 0, 255]);
  });

  it("fails a step with an empty secret and leaves an undefined variable literal", async () => {
    const { verdict, results } = await run(
      plan([
        { id: "s1", action: "goto", url: "/{{NOPE}}" },
        { id: "s2", action: "fill", selector: "#x", value: "{{EMPTY}}" },
        { id: "s3", action: "goto", url: "/" },
      ], { EMPTY: { value: "", secret: true } }),
    );
    expect(verdict.status).toBe("failed");
    expect(results.map((r) => [r.status, r.errorCode])).toEqual([["passed", undefined], ["failed", "missing_secret"], ["skipped", undefined]]);
    expect(results[1]!.attempts).toBe(0);
  });

  it("continues after an optional step fails and the run still passes", async () => {
    const { verdict, results } = await run(
      plan([
        { id: "s1", action: "goto", url: "/" },
        { id: "s2", action: "assertText", selector: "h1", expected: "Nope", timeout: 300, optional: true },
        { id: "s3", action: "assertText", selector: "h1", expected: "Fixture Shop" },
      ]),
    );
    expect(results.map((r) => r.status)).toEqual(["passed", "skipped", "passed"]);
    expect(verdict.status).toBe("passed");
  });

  it("blocks cloud metadata requests from pages, frames and navigation", async () => {
    const { verdict, results, events } = await run(
      plan([
        { id: "s1", action: "goto", url: "/network.html" },
        { id: "s2", action: "goto", url: "http://169.254.169.254/latest/meta-data/" },
      ]),
    );
    expect(verdict.status).toBe("failed");
    expect(results[1]).toMatchObject({ status: "failed", errorCode: "blocked_request", attempts: 1 });
    const logs = events.flatMap((e) => (e.type === "log" ? [e.message] : []));
    expect(logs).toEqual(expect.arrayContaining([expect.stringContaining("http://169.254.169.254/computeMetadata/v1/")]));
    expect(results[1]!.errorMessage).toContain("http://169.254.169.254/latest/meta-data/");
  });

  it("blocks metadata addresses behind a redirect, which request interception never sees, even when optional", async () => {
    const via = (to: string) => `/redirect?to=${encodeURIComponent(to)}`;
    const targets = ["http://169.254.169.254/latest/meta-data/", "http://[::ffff:a9fe:a9fe]/", "http://[fd00:ec2::254]/", "http://metadata.google.internal/computeMetadata/v1/"];
    const started = Date.now();
    const outcomes = await Promise.all(targets.map((to) => run(plan([{ id: "s", action: "goto", url: via(to), timeout: 5_000, optional: true }]))));
    // Refused by the browser itself, not left to time out against an unreachable address.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcomes.map((o) => [o.results[0]!.status, o.results[0]!.errorCode])).toEqual(targets.map(() => ["failed", "blocked_request"]));
    const logs = outcomes[0]!.events.flatMap((e) => (e.type === "log" ? [e.message] : []));
    expect(logs).toEqual(expect.arrayContaining([expect.stringContaining("Blocked request to http://169.254.169.254/latest/meta-data/")]));
  });

  it("stops on the abort signal: the running step gets the cause, the rest are skipped, the browser is gone", async () => {
    for (const reason of ["cancelled", "timed_out"] as const) {
      const p = plan([
        { id: "s1", action: "goto", url: "/" },
        { id: "s2", action: "waitForSelector", selector: "#never", timeout: 60_000 },
        { id: "s3", action: "click", selector: "a" },
      ]);
      const controller = new AbortController();
      const started = Date.now();
      const running = run(p, controller.signal);
      setTimeout(() => controller.abort(reason), 1_500);
      const { verdict, results } = await running;
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(verdict.status).toBe(reason);
      expect(results.map((r) => r.status)).toEqual(["passed", reason, "skipped"]);
      await noBrowserLeftFor(p.runId);
    }
  });
});

describe("sweepBrowsers", () => {
  it("kills browsers whose owner is gone and leaves live owners alone", async () => {
    // A finished child process stands in for a worker that was SIGKILLed.
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => dead.once("exit", r));
    const orphan = await chromium.launchServer({ chromiumSandbox: SANDBOX, args: [`--defe2end-owner=${dead.pid}`, "--defe2end-run=orphan-run"] });
    const live = await chromium.launchServer({ chromiumSandbox: SANDBOX, args: [`--defe2end-owner=${process.pid}`, "--defe2end-run=live-run"] });
    // Only the dead owner: other test processes (the worker tests) may have live browsers right now.
    const isStale = (owner: string) => owner === String(dead.pid);
    // Asserts the outcome only: a worker test starting at the same time may sweep the orphan first.
    await sweepBrowsers(isStale);
    const left = (await listMarkedBrowsers()).map((p) => p.runId);
    expect(left).not.toContain("orphan-run");
    expect(left).toContain("live-run");
    await live.close();
    await orphan.close().catch(() => {});
  });
});

describe("executablePath", () => {
  it("launches the given browser binary instead of Playwright's installed one", async () => {
    const plan = makePlan("http://127.0.0.1:9/", []);
    const verdict = await runPlan(plan, { sink: memorySink().sink, signal: new AbortController().signal, owner: String(process.pid), sandbox: SANDBOX, onEvent: () => {}, executablePath: "/nonexistent/defe2end/chrome-headless-shell" });
    expect(verdict).toMatchObject({ status: "error", errorCode: "browser_launch_failed" });
    expect(verdict.errorMessage).toContain("/nonexistent/defe2end/chrome-headless-shell");
  });
});

describe("headless", () => {
  // A visible window needs a display; Linux CI without one skips the visible half.
  const canShow = process.platform !== "linux" || !!process.env.DISPLAY;
  const userAgent = async (headless?: boolean) => {
    const running = await launchBrowser({ owner: String(process.pid), runId: `headless-${headless}`, sandbox: SANDBOX, hostRules: "", ...(headless === undefined ? {} : { headless }) });
    try {
      const page = await running.browser.newPage();
      return await page.evaluate(() => navigator.userAgent);
    } finally {
      await running.close();
    }
  };

  it("stays headless by default (the worker)", async () => {
    expect(await userAgent()).toContain("HeadlessChrome");
  });

  it.skipIf(!canShow)("shows the window when asked (the desktop app's default)", async () => {
    expect(await userAgent(false)).not.toContain("HeadlessChrome");
  });
});

describe("a window closed at the PC (userCanClose)", () => {
  const closeFirstPage: Step[] = [
    { id: "open", action: "goto", url: "/popup.html" },
    { id: "wait", action: "wait", timeout: 3_000 },
    { id: "after", action: "assertVisible", selector: "#close" },
  ];
  /** Closes the first page from outside the runner as soon as the `wait` step starts. */
  const closer = () => {
    let page: Page | undefined;
    return {
      internals: { onFirstPage: (p: Page) => void (page = p) },
      onStep: (e: RunnerEvent) => {
        if (e.type === "stepStarted" && e.stepId === "wait") setTimeout(() => void page?.close(), 200);
      },
    };
  };

  for (const headless of [true, false]) {
    it.skipIf(!headless && process.platform === "linux" && !process.env.DISPLAY)(`cancels without retrying (${headless ? "headless" : "visible"})`, async () => {
      const results: { attempt: number; status: string; id: string }[] = [];
      const retried = await runWithRetries({
        policy: { maxAttempts: 2, retryOnFailure: true, runTimeoutMs: 60_000 },
        startedAt: Date.now(),
        signal: new AbortController().signal,
        stop: () => {},
        runAttempt: (attempt) => {
          const close = closer();
          return runPlanWith(
            { ...plan(closeFirstPage), attempt },
            {
              sink: memorySink().sink,
              signal: new AbortController().signal,
              owner: String(process.pid),
              sandbox: SANDBOX,
              headless,
              userCanClose: true,
              onEvent: (e) => {
                close.onStep(e);
                if (e.type === "stepFinished") results.push({ attempt: e.result.attempt, status: e.result.status, id: e.result.stepId });
              },
            },
            close.internals,
          );
        },
      });
      expect(retried).toMatchObject({ verdict: { status: "cancelled" }, attemptCount: 1, stopCause: { type: "cancelled" } });
      expect(results.map((r) => [r.id, r.status])).toEqual([["open", "passed"], ["wait", "cancelled"], ["after", "skipped"]]);
    });
  }

  it("stays as before for the worker (option unset): the step fails, no cancel", async () => {
    const close = closer();
    const statuses: string[] = [];
    const verdict = await runPlanWith(plan(closeFirstPage), { sink: memorySink().sink, signal: new AbortController().signal, owner: String(process.pid), sandbox: SANDBOX, onEvent: (e) => {
      close.onStep(e);
      if (e.type === "stepFinished") statuses.push(e.result.status);
    } }, close.internals);
    expect(verdict.status).toBe("failed");
    expect(statuses).toEqual(["passed", "failed", "skipped"]);
  });

  it("leaves closing a popup alone", async () => {
    const events: RunnerEvent[] = [];
    const verdict = await runPlan(
      plan([
        { id: "open", action: "goto", url: "/actions.html" },
        { id: "pop", action: "clickAndWaitPopup", selector: "#popup-one" },
        { id: "close", action: "clickInPopup", selector: "#close" },
        { id: "wait", action: "wait", timeout: 500 },
        { id: "still", action: "assertVisible", selector: "#title" },
      ]),
      { sink: memorySink().sink, signal: new AbortController().signal, owner: String(process.pid), sandbox: SANDBOX, userCanClose: true, onEvent: (e) => void events.push(e) },
    );
    expect(verdict.status).toBe("passed");
  });
});
