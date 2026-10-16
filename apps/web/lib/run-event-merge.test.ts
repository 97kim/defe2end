import { expect, it } from "vitest";
import { applyRunEvent, diffRun } from "./run-event-merge";
import type { RunDetail } from "./run-read";

const base: RunDetail = {
  id: "r1",
  status: "running",
  cancelRequested: false,
  trigger: "manual",
  scenarioId: "s1",
  scenarioName: "Log in",
  environmentId: "e1",
  environmentName: "Staging",
  groupRunId: null,
  requestedByName: "Mina",
  errorCode: null,
  queuedAt: "2026-10-11T00:00:00.000Z",
  startedAt: "2026-10-11T00:00:01.000Z",
  finishedAt: null,
  durationMs: null,
  cancelRequestedAt: null,
  errorMessage: null,
  runnerVersion: "0.1.0",
  browserVersion: null,
  workerId: "w1",
  location: "server",
  deviceLabel: null,
  baseUrl: "https://example.com",
  steps: [
    { index: 0, stepId: "a", action: "goto", url: "/", maxAttempts: 2, result: null },
    { index: 1, stepId: "b", action: "click", selector: "#go", maxAttempts: 2, result: null },
  ],
  artifacts: [],
  attemptCount: 1,
  previousAttempts: [],
  warningCount: 0,
  passedAfterRetry: false,
};

it("sends nothing when nothing changed, and only what changed otherwise", () => {
  expect(diffRun(base, structuredClone(base))).toBeNull();
  const next = structuredClone(base);
  next.steps[0]!.result = { status: "passed", attempts: 1, startedAt: base.startedAt!, durationMs: 300, errorCode: null, errorMessage: null, expected: null, actual: null, possibleDuplicate: false };
  next.artifacts.push({ id: "a1", kind: "screenshot", stepIndex: 0, attempt: 1, name: "home", sizeBytes: 10, url: "/x" });
  const update = diffRun(base, next)!;
  expect(update.steps.map((s) => s.index)).toEqual([0]);
  expect(update.artifacts.map((a) => a.id)).toEqual(["a1"]);
  expect(applyRunEvent(base, update)).toEqual(next);
});

it("a snapshot replaces the screen's copy (reconnect), and merging is idempotent by id", () => {
  const next = { ...structuredClone(base), status: "passed" as const };
  expect(applyRunEvent(null, { type: "snapshot", run: next })).toBe(next);
  const update = { type: "update" as const, run: (({ steps, artifacts, ...r }) => r)(next), steps: [], artifacts: [{ id: "a1", kind: "log" as const, stepIndex: null, attempt: 1, name: "run.log", sizeBytes: 1, url: "/l" }] };
  const once = applyRunEvent(base, update)!;
  expect(applyRunEvent(once, update)!.artifacts).toHaveLength(1);
});
