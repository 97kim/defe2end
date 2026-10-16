import type { RunTerminalStatus } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import {
  classifyFailing,
  clusterFailures,
  dailySeries,
  dayKey,
  failingNow,
  parsePeriod,
  passRate,
  periodRange,
  summarize,
  topFailing,
  type DashboardRun,
} from "./dashboard-calc";

const s = (...statuses: RunTerminalStatus[]) => statuses.map((status) => ({ status }));

let seq = 0;
function run(over: Partial<Omit<DashboardRun, "at">> & { status: RunTerminalStatus; at: string }): DashboardRun {
  return { id: `r${++seq}`, scenarioId: "s1", scenarioName: "Login", environmentId: "e1", environmentName: "prod", durationMs: 1000, ...over, at: new Date(over.at) };
}

describe("periods", () => {
  it("day keys follow the workspace time zone", () => {
    const instant = new Date("2026-10-13T16:30:00Z");
    expect(dayKey(instant, "UTC")).toBe("2026-10-13");
    expect(dayKey(instant, "Asia/Seoul")).toBe("2026-10-14");
  });

  it("covers the last N local days ending tomorrow 00:00", () => {
    const now = new Date("2026-10-13T16:30:00Z"); // 01:30 on the 14th in Seoul
    const seoul = periodRange(7, now, "Asia/Seoul");
    expect(seoul.days).toEqual(["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(seoul.from.toISOString()).toBe("2026-10-07T15:00:00.000Z");
    expect(seoul.to.toISOString()).toBe("2026-10-14T15:00:00.000Z");

    const utc = periodRange(7, now, "UTC");
    expect(utc.days.at(-1)).toBe("2026-10-13");
    expect(utc.from.toISOString()).toBe("2026-10-07T00:00:00.000Z");
    expect(utc.to.toISOString()).toBe("2026-10-14T00:00:00.000Z");
  });

  it("handles negative offsets and month edges", () => {
    const r = periodRange(30, new Date("2026-03-01T03:00:00Z"), "America/New_York"); // Feb 28, 22:00 local
    expect(r.days).toHaveLength(30);
    expect(r.days.at(-1)).toBe("2026-02-28");
    expect(r.to.toISOString()).toBe("2026-03-01T05:00:00.000Z");
  });

  it("falls back to 7 days for unknown periods", () => {
    expect(parsePeriod("30")).toBe(30);
    expect(parsePeriod("90")).toBe(90);
    expect(parsePeriod("14")).toBe(7);
    expect(parsePeriod(undefined)).toBe(7);
  });
});

describe("classifyFailing (newest first)", () => {
  it("is null when the last counted run passed", () => {
    expect(classifyFailing(s("passed", "failed", "failed"))).toBeNull();
    expect(classifyFailing([])).toBeNull();
    expect(classifyFailing(s("cancelled", "passed", "failed"))).toBeNull();
  });

  it("new: only the last failed, previous passed or none", () => {
    expect(classifyFailing(s("failed"))?.kind).toBe("new");
    expect(classifyFailing(s("error", "passed", "passed", "passed", "passed", "failed"))?.kind).toBe("new");
  });

  it("consecutive: two or more in a row, even with older passes", () => {
    expect(classifyFailing(s("failed", "timed_out", "passed", "failed"))).toMatchObject({ kind: "consecutive", streak: 2 });
  });

  it("intermittent: a single fresh failure with another failure among the last five", () => {
    expect(classifyFailing(s("failed", "passed", "failed", "passed"))).toMatchObject({ kind: "intermittent", streak: 1 });
  });

  it("skips cancelled runs", () => {
    expect(classifyFailing(s("failed", "cancelled", "failed"))?.kind).toBe("consecutive");
    expect(classifyFailing(s("cancelled", "failed", "passed"))).toMatchObject({ kind: "new", history: ["failed", "passed"] });
  });

  it("groups by scenario × environment and orders new, consecutive, intermittent", () => {
    const runs = [
      run({ status: "failed", at: "2026-10-10T00:00:00Z" }),
      run({ status: "failed", at: "2026-10-11T00:00:00Z" }),
      run({ status: "passed", at: "2026-10-11T00:00:00Z", environmentId: "e2" }),
      run({ status: "failed", at: "2026-10-12T00:00:00Z", environmentId: "e2" }),
      run({ status: "failed", at: "2026-10-12T00:00:00Z", scenarioId: "s2", environmentId: "e1" }),
      run({ status: "passed", at: "2026-10-12T00:00:00Z", scenarioId: "s3" }),
      run({ status: "failed", at: "2026-10-12T00:00:00Z", scenarioId: null }),
    ];
    const items = failingNow(runs);
    expect(items.map((i) => [i.scenarioId, i.environmentId, i.kind])).toEqual([
      ["s1", "e2", "new"],
      ["s2", "e1", "new"],
      ["s1", "e1", "consecutive"],
    ]);
  });
});

describe("clusterFailures", () => {
  const cause = { action: "click", reason: "element not found: #buy" };
  it("groups three or more with the same step action and reason", () => {
    const items = ["a", "b", "c", "d", "e"];
    const causes: Record<string, typeof cause | undefined> = { a: cause, b: cause, c: { ...cause }, d: { action: "fill", reason: cause.reason }, e: undefined };
    const { clusters, singles } = clusterFailures(items, (i) => causes[i]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.items).toEqual(["a", "b", "c"]);
    expect(singles).toEqual(["d", "e"]);
  });

  it("leaves pairs alone", () => {
    const { clusters, singles } = clusterFailures(["a", "b"], () => cause);
    expect(clusters).toEqual([]);
    expect(singles).toEqual(["a", "b"]);
  });
});

describe("rates, series, top failing, summary", () => {
  it("pass rate excludes cancelled", () => {
    expect(passRate(s("passed", "failed", "cancelled", "cancelled"))).toBe(0.5);
    expect(passRate(s("cancelled"))).toBeNull();
  });

  it("daily series buckets by local day", () => {
    const range = periodRange(2, new Date("2026-10-14T03:00:00Z"), "Asia/Seoul"); // 13th and 14th
    const series = dailySeries(
      [
        run({ status: "passed", at: "2026-10-13T16:00:00Z" }), // 14th 01:00 Seoul
        run({ status: "failed", at: "2026-10-13T14:00:00Z" }), // 13th 23:00 Seoul
        run({ status: "cancelled", at: "2026-10-13T14:00:00Z" }),
      ],
      range,
      "Asia/Seoul",
    );
    expect(series).toEqual([
      { day: "2026-10-13", passed: 0, failed: 1, cancelled: 1, rate: 0 },
      { day: "2026-10-14", passed: 1, failed: 0, cancelled: 0, rate: 1 },
    ]);
  });

  it("top failing needs three counted runs and a failure; failures, then runs", () => {
    const at = "2026-10-12T00:00:00Z";
    const runs = [
      ...["failed", "passed", "passed", "passed"].map((st) => run({ status: st as RunTerminalStatus, at, scenarioId: "a", scenarioName: "A" })),
      ...["failed", "failed", "passed"].map((st) => run({ status: st as RunTerminalStatus, at, scenarioId: "b", scenarioName: "B" })),
      ...["failed", "passed", "passed"].map((st) => run({ status: st as RunTerminalStatus, at, scenarioId: "c", scenarioName: "C", environmentId: "e9" })),
      ...["failed", "failed", "cancelled"].map((st) => run({ status: st as RunTerminalStatus, at, scenarioId: "d", scenarioName: "D" })),
      ...["passed", "passed", "passed"].map((st) => run({ status: st as RunTerminalStatus, at, scenarioId: "e", scenarioName: "E" })),
    ];
    expect(topFailing(runs).map((r) => [r.scenarioId, r.failures, r.runs])).toEqual([
      ["b", 2, 3],
      ["a", 1, 4],
      ["c", 1, 3],
    ]);
  });

  it("summary counts missed by missedCount", () => {
    const runs = [run({ status: "passed", at: "2026-10-12T00:00:00Z", durationMs: 1000 }), run({ status: "failed", at: "2026-10-12T01:00:00Z", durationMs: 3000 }), run({ status: "cancelled", at: "2026-10-12T00:00:00Z", durationMs: null })];
    const summary = summarize(runs, failingNow(runs), [
      { status: "missed", missedCount: 4 },
      { status: "missed", missedCount: null },
      { status: "skipped_overlap", missedCount: null },
      { status: "refused", missedCount: null },
      { status: "started", missedCount: null },
    ]);
    expect(summary).toEqual({ passRate: 0.5, runCount: 3, avgDurationMs: 2000, failingNow: 1, missed: 5, skipped: 1, refused: 1 });
  });
});
