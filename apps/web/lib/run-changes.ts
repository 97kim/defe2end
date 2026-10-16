// "Changed since last pass" (stage 3, ap-2): facts computed from stored runs only. Pure, so it is unit-tested
// without a database; lib/run-read.ts loads the runs.
import type { StepResultStatus } from "@defe2end/shared";

export interface ComparableStep {
  index: number;
  stepId: string;
  action: string;
  target?: string;
  value?: string;
  options?: unknown;
  /** Null: no result stored (not reached yet, or never run). */
  status: StepResultStatus | null;
  durationMs: number | null;
}

export interface ComparableRun {
  id: string;
  baseUrl: string;
  runnerVersion: string | null;
  browserVersion: string | null;
  steps: ComparableStep[];
}

export type RunChange =
  | { kind: "stepsEdited"; added: number; removed: number; edited: number }
  | { kind: "outcome"; index: number; status: StepResultStatus | "notRun"; previous: StepResultStatus | "notRun" }
  | { kind: "slowStep"; index: number; durationMs: number; usualMs: number }
  | { kind: "baseUrl"; from: string; to: string }
  | { kind: "runnerVersion"; from: string; to: string }
  | { kind: "browserVersion"; from: string; to: string };

/** A step counts as slow above this multiple of its usual (median) duration in recent passes… */
export const SLOW_FACTOR = 2;
/** …and only when it is at least this much slower, so 20 ms → 50 ms is not reported. */
export const MIN_SLOWDOWN_MS = 200;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const definition = (s: ComparableStep) => JSON.stringify([s.action, s.target ?? null, s.value ?? null, s.options ?? null]);

/**
 * Compares `current` with `baseline` (the latest earlier `passed` run of the same scenario and environment).
 * `recentPasses` (baseline included) give each step's usual duration. Steps are matched by step id, so
 * reordering or editing the scenario doesn't shift the comparison. `finished`: steps without a result count
 * as "not run" (a running run's unreached steps are simply not compared yet).
 */
export function computeRunChanges(current: ComparableRun, baseline: ComparableRun, recentPasses: ComparableRun[], finished: boolean): RunChange[] {
  const changes: RunChange[] = [];
  const before = new Map(baseline.steps.map((s) => [s.stepId, s]));
  const now = new Set(current.steps.map((s) => s.stepId));

  const added = current.steps.filter((s) => !before.has(s.stepId)).length;
  const removed = baseline.steps.filter((s) => !now.has(s.stepId)).length;
  const edited = current.steps.filter((s) => before.has(s.stepId) && definition(before.get(s.stepId)!) !== definition(s)).length;
  if (added || removed || edited) changes.push({ kind: "stepsEdited", added, removed, edited });

  for (const step of current.steps) {
    const prev = before.get(step.stepId);
    if (!prev || (step.status === null && !finished)) continue;
    const status = step.status ?? "notRun";
    const previous = prev.status ?? "notRun";
    if (status !== previous) {
      changes.push({ kind: "outcome", index: step.index, status, previous });
      break;
    }
  }

  const slow: Extract<RunChange, { kind: "slowStep" }>[] = [];
  for (const step of current.steps) {
    // Passed steps only: a failed step's time is mostly its wait for the timeout, and its outcome is reported above.
    if (step.durationMs === null || step.status !== "passed") continue;
    const samples = recentPasses.flatMap((run) => run.steps.filter((s) => s.stepId === step.stepId && s.status === "passed" && s.durationMs !== null).map((s) => s.durationMs!));
    if (samples.length === 0) continue;
    const usualMs = median(samples);
    if (step.durationMs > usualMs * SLOW_FACTOR && step.durationMs - usualMs >= MIN_SLOWDOWN_MS) {
      slow.push({ kind: "slowStep", index: step.index, durationMs: step.durationMs, usualMs: Math.round(usualMs) });
    }
  }
  changes.push(...slow.sort((a, b) => b.durationMs / b.usualMs - a.durationMs / a.usualMs));

  if (current.baseUrl !== baseline.baseUrl) changes.push({ kind: "baseUrl", from: baseline.baseUrl, to: current.baseUrl });
  if (current.runnerVersion && baseline.runnerVersion && current.runnerVersion !== baseline.runnerVersion) {
    changes.push({ kind: "runnerVersion", from: baseline.runnerVersion, to: current.runnerVersion });
  }
  if (current.browserVersion && baseline.browserVersion && current.browserVersion !== baseline.browserVersion) {
    changes.push({ kind: "browserVersion", from: baseline.browserVersion, to: current.browserVersion });
  }
  return changes;
}
