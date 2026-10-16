import { messages } from "@defe2end/i18n";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { RunDetail } from "../../../../lib/run-read";
import { summarizeTestRun, TestRunCard } from "./last-test-run";

const result = (status: "passed" | "failed", errorMessage: string | null = null) => ({
  status, attempts: 1, startedAt: "2026-10-13T00:00:01.000Z", durationMs: 10, errorCode: null, errorMessage, expected: null, actual: null, possibleDuplicate: false,
});
const run = (over: Partial<RunDetail>): RunDetail => ({
  id: "r1", status: "running", cancelRequested: false, trigger: "test", scenarioId: null, scenarioName: "Test run", environmentId: "e1", environmentName: "Staging",
  groupRunId: null, requestedByName: "Mina Park", errorCode: null, queuedAt: "2026-10-13T00:00:00.000Z", startedAt: "2026-10-13T00:00:01.000Z", finishedAt: null,
  durationMs: null, cancelRequestedAt: null, errorMessage: null, runnerVersion: null, browserVersion: null, workerId: null, location: "server", deviceLabel: null,
  baseUrl: "https://shop.example.com",
  steps: [
    { index: 0, stepId: "a", action: "goto", url: "/", maxAttempts: 2, result: result("passed") },
    { index: 1, stepId: "b", action: "click", name: "Pay", selector: "#pay", maxAttempts: 2, result: null },
    { index: 2, stepId: "c", action: "assertText", selector: "h1", maxAttempts: 2, result: null },
  ],
  artifacts: [], attemptCount: 1, previousAttempts: [], warningCount: 0, passedAfterRetry: false,
  ...over,
} as RunDetail);

const render = (summary: ReturnType<typeof summarizeTestRun> | null, locale: "en" | "ko" = "en") =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      <TestRunCard slug="acme" runId="r1" summary={summary} />
    </NextIntlClientProvider>,
  );

it("shows progress and 'running on my PC' while a desktop test run is active", () => {
  const summary = summarizeTestRun(run({ location: "desktop", deviceLabel: "Mina's MacBook" }));
  expect(summary).toMatchObject({ active: true, done: 1, total: 3, failedStep: null });
  const html = render(summary);
  expect(html).toContain("Step 1/3");
  expect(html).toContain("Running on my PC · Mina&#x27;s MacBook");
  expect(render(summary, "ko")).toContain("내 PC에서 실행 중");
});

it("shows a failed test run with the failed step number, reason and a link to the result", () => {
  const failed = run({
    status: "failed",
    finishedAt: "2026-10-13T00:00:05.000Z",
    steps: [
      { index: 0, stepId: "a", action: "goto", url: "/", maxAttempts: 2, result: result("passed") },
      { index: 1, stepId: "b", action: "click", name: "Pay", selector: "#pay", maxAttempts: 2, result: result("failed", "Element not found: #pay") },
    ],
  });
  const summary = summarizeTestRun(failed);
  expect(summary.failedStep).toEqual({ number: 2, name: "Pay", reason: "Element not found: #pay" });
  const html = render(summary);
  expect(html).toContain("Failed");
  expect(html).toContain("Step 2 failed: Pay");
  expect(html).toContain("Element not found: #pay");
  expect(html).toContain('href="/w/acme/runs/r1"');
  expect(html).not.toContain("border-l-");
  expect(html).not.toContain("Step 2/2");
});

it("shows a loading state before the run is read", () => {
  expect(render(null)).toContain("Loading");
});
