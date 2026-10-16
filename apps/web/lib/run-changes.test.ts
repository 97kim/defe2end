import { describe, expect, it } from "vitest";
import { computeRunChanges, type ComparableRun, type ComparableStep } from "./run-changes";

const step = (index: number, stepId: string, status: ComparableStep["status"], durationMs: number | null, extra: Partial<ComparableStep> = {}): ComparableStep => ({
  index,
  stepId,
  action: "click",
  target: `#${stepId}`,
  status,
  durationMs,
  ...extra,
});
const run = (id: string, steps: ComparableStep[], extra: Partial<ComparableRun> = {}): ComparableRun => ({
  id,
  baseUrl: "https://staging.example.com",
  runnerVersion: "0.1.0",
  browserVersion: "131.0",
  steps,
  ...extra,
});
const passing = (id: string, d = [1000, 900, 1200]) => run(id, [step(0, "a", "passed", d[0]!), step(1, "b", "passed", d[1]!), step(2, "c", "passed", d[2]!)]);

describe("computeRunChanges", () => {
  it("reports nothing when the run matches its last pass", () => {
    const base = passing("p1");
    expect(computeRunChanges(passing("now"), base, [base], true)).toEqual([]);
  });

  it("flags a step over 2× its median duration in recent passes, not one under it", () => {
    const passes = [passing("p1", [1000, 900, 1200]), passing("p2", [1100, 1000, 1000]), passing("p3", [900, 950, 5000])];
    const current = passing("now", [2500, 1800, 2000]);
    // a: median 1000 → 2500 (>2×). b: median 950 → 1800 (<2×). c: median 1200 → 2000 (<2×; the 5000 outlier doesn't lower the bar).
    expect(computeRunChanges(current, passes[0]!, passes, true)).toEqual([{ kind: "slowStep", index: 0, durationMs: 2500, usualMs: 1000 }]);
  });

  it("ignores tiny absolute slowdowns even above 2×", () => {
    const base = run("p1", [step(0, "a", "passed", 20)]);
    expect(computeRunChanges(run("now", [step(0, "a", "passed", 90)]), base, [base], true)).toEqual([]);
  });

  it("reports the first step whose outcome differs, matched by step id", () => {
    const base = passing("p1");
    const current = run("now", [step(0, "a", "passed", 1000), step(1, "b", "failed", 15000), step(2, "c", null, null)]);
    const changes = computeRunChanges(current, base, [base], true);
    // Its 15 s are the wait for the timeout, not a slowdown worth a separate line.
    expect(changes).toEqual([{ kind: "outcome", index: 1, status: "failed", previous: "passed" }]);
  });

  it("treats unreached steps as not run only once the run is finished", () => {
    const base = passing("p1");
    const current = run("now", [step(0, "a", "passed", 1000), step(1, "b", null, null), step(2, "c", null, null)]);
    expect(computeRunChanges(current, base, [base], false)).toEqual([]);
    expect(computeRunChanges(current, base, [base], true)).toEqual([{ kind: "outcome", index: 1, status: "notRun", previous: "passed" }]);
  });

  it("reports edited, added and removed steps; reordering alone is no edit", () => {
    const base = passing("p1");
    const current = run("now", [step(0, "c", "passed", 1200), step(1, "a", "passed", 1000, { target: "#changed" }), step(2, "new", "passed", 100)]);
    expect(computeRunChanges(current, base, [base], true)).toEqual([{ kind: "stepsEdited", added: 1, removed: 1, edited: 1 }]);
  });

  it("reports environment URL and version changes, skipping unknown versions", () => {
    const base = passing("p1");
    const current = run("now", passing("x").steps, { baseUrl: "https://staging2.example.com", runnerVersion: "0.2.0", browserVersion: null });
    expect(computeRunChanges(current, base, [base], true)).toEqual([
      { kind: "baseUrl", from: "https://staging.example.com", to: "https://staging2.example.com" },
      { kind: "runnerVersion", from: "0.1.0", to: "0.2.0" },
    ]);
  });
});
