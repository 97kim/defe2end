import type { RunTerminalStatus } from "@defe2end/shared";

// Dashboard numbers (stage 5 contract section 8), without the database: lib/dashboard.ts loads the rows.
// Cancelled runs say nothing about the product, so they never count toward pass rates or failure streaks.

export const DASHBOARD_PERIODS = [7, 30, 90] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

/** Runs (or history entries) looked at when deciding "intermittent". */
export const INTERMITTENT_WINDOW = 5;
/** Failing items sharing a step and reason are grouped from this many. */
export const CLUSTER_MIN = 3;
/** Top failing scenarios need this many runs in the period. */
export const TOP_FAILING_MIN_RUNS = 3;
export const TOP_FAILING_LIMIT = 10;

// --- Period and day keys -------------------------------------------------------------------------

export interface PeriodRange {
  /** Start of the first day, in the workspace time zone. */
  from: Date;
  /** Start of the day after today (exclusive). */
  to: Date;
  /** `YYYY-MM-DD` per day, oldest first; `days.length` is the period. */
  days: string[];
}

const keyFormatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(instant: Date, timeZone: string) {
  let f = keyFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    keyFormatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), s: Number(p.second) };
}

/** The calendar day of `instant` in `timeZone`, as `YYYY-MM-DD`. */
export function dayKey(instant: Date, timeZone: string): string {
  const { y, m, d } = partsIn(instant, timeZone);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Local time minus UTC at `instant`, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  const p = partsIn(new Date(instant), timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(instant / 1000) * 1000;
}

/** 00:00 of the given local date in `timeZone` (the offset is checked twice so a nearby offset change is honoured). */
function startOfDay(y: number, m: number, d: number, timeZone: string): Date {
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - offsetAt(wall, timeZone);
  return new Date(wall - offsetAt(first, timeZone));
}

/** The last `days` calendar days up to and including today, in the workspace time zone. */
export function periodRange(days: number, now: Date, timeZone: string): PeriodRange {
  const today = partsIn(now, timeZone);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.UTC(today.y, today.m - 1, today.d - i));
    keys.push(date.toISOString().slice(0, 10));
  }
  const first = new Date(Date.UTC(today.y, today.m - 1, today.d - (days - 1)));
  const next = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
  return {
    from: startOfDay(first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate(), timeZone),
    to: startOfDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone),
    days: keys,
  };
}

export function parsePeriod(raw: string | undefined): DashboardPeriod {
  const n = Number(raw);
  return (DASHBOARD_PERIODS as readonly number[]).includes(n) ? (n as DashboardPeriod) : 7;
}

// --- Runs ----------------------------------------------------------------------------------------

export interface DashboardRun {
  id: string;
  /** Null once the scenario is deleted: counted in totals, left out of per-scenario lists. */
  scenarioId: string | null;
  scenarioName: string;
  environmentId: string | null;
  environmentName: string;
  status: RunTerminalStatus;
  /** The run's place in time (queuedAt): day buckets and newest-first order. */
  at: Date;
  durationMs: number | null;
}

const counts = (status: RunTerminalStatus) => status !== "cancelled";
const passed = (status: RunTerminalStatus) => status === "passed";

/** passed / (passed + not passed), cancelled left out; null when nothing counts. */
export function passRate(runs: { status: RunTerminalStatus }[]): number | null {
  const counted = runs.filter((r) => counts(r.status));
  return counted.length === 0 ? null : counted.filter((r) => passed(r.status)).length / counted.length;
}

export interface DailyPoint {
  day: string;
  passed: number;
  /** Finished and not passed, cancelled excluded. */
  failed: number;
  cancelled: number;
  rate: number | null;
}

export function dailySeries(runs: DashboardRun[], range: PeriodRange, timeZone: string): DailyPoint[] {
  const byDay = new Map(range.days.map((day) => [day, { day, passed: 0, failed: 0, cancelled: 0, rate: null as number | null }]));
  for (const r of runs) {
    const point = byDay.get(dayKey(r.at, timeZone));
    if (!point) continue;
    if (r.status === "cancelled") point.cancelled++;
    else if (passed(r.status)) point.passed++;
    else point.failed++;
  }
  for (const p of byDay.values()) p.rate = p.passed + p.failed === 0 ? null : p.passed / (p.passed + p.failed);
  return [...byDay.values()];
}

// --- Failing now ---------------------------------------------------------------------------------

export type FailingKind = "new" | "consecutive" | "intermittent";

/** Display order: new failures first (most likely caused by a recent change), flaky ones last. */
export const FAILING_KIND_ORDER: Record<FailingKind, number> = { new: 0, consecutive: 1, intermittent: 2 };

export interface FailingItem {
  scenarioId: string;
  scenarioName: string;
  environmentId: string;
  environmentName: string;
  kind: FailingKind;
  /** Non-passed runs in a row, newest first. */
  streak: number;
  lastRunId: string;
  lastStatus: RunTerminalStatus;
  lastAt: Date;
  /** Up to INTERMITTENT_WINDOW statuses, newest first. */
  history: RunTerminalStatus[];
}

/**
 * Classifies one scenario × environment from its finished runs, newest first. Cancelled runs are skipped.
 * Null when the last run passed (or there is none). Otherwise, in this precedence:
 * - `consecutive`: the last two or more are not passed — a streak says more than its past;
 * - `intermittent`: only the last one failed, but another failure sits among the last INTERMITTENT_WINDOW
 *   with passes in between (so a single fresh failure after flaky history is not called new);
 * - `new`: only the last one failed and nothing else did in the window (previous passed, or no history).
 */
export function classifyFailing(runsNewestFirst: { status: RunTerminalStatus }[]): { kind: FailingKind; streak: number; history: RunTerminalStatus[] } | null {
  const history = runsNewestFirst.map((r) => r.status).filter(counts);
  if (history.length === 0 || passed(history[0]!)) return null;
  let streak = 0;
  while (streak < history.length && !passed(history[streak]!)) streak++;
  const window = history.slice(0, INTERMITTENT_WINDOW);
  const kind: FailingKind = streak >= 2 ? "consecutive" : window.slice(1).some((s) => !passed(s)) ? "intermittent" : "new";
  return { kind, streak, history: window };
}

/** Every scenario × environment whose last finished run did not pass, in display order. */
export function failingNow(runs: DashboardRun[]): FailingItem[] {
  const groups = new Map<string, DashboardRun[]>();
  for (const r of runs) {
    if (!r.scenarioId || !r.environmentId) continue;
    const key = `${r.scenarioId}\u0000${r.environmentId}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const items: FailingItem[] = [];
  for (const list of groups.values()) {
    const sorted = list.filter((r) => counts(r.status)).sort((a, b) => b.at.getTime() - a.at.getTime());
    const result = classifyFailing(sorted);
    if (!result) continue;
    const last = sorted[0]!;
    items.push({
      scenarioId: last.scenarioId!,
      scenarioName: last.scenarioName,
      environmentId: last.environmentId!,
      environmentName: last.environmentName,
      ...result,
      lastRunId: last.id,
      lastStatus: last.status,
      lastAt: last.at,
    });
  }
  return items.sort((a, b) => FAILING_KIND_ORDER[a.kind] - FAILING_KIND_ORDER[b.kind] || b.lastAt.getTime() - a.lastAt.getTime());
}

// --- Clusters ------------------------------------------------------------------------------------

/** Where the last run of a failing item broke: the first failed step of its final attempt, or the run itself. */
export interface FailureCause {
  /** The step's action (e.g. `click`); null when the run failed outside any step. */
  action: string | null;
  /** errorCode, or the first line of errorMessage; never empty. */
  reason: string;
}

export interface FailureCluster<T> {
  cause: FailureCause;
  items: T[];
}

/** First line, at most 300 characters. */
export function reasonLine(errorCode: string | null, errorMessage: string | null): string {
  const line = errorMessage?.split("\n", 1)[0]?.trim().slice(0, 300);
  return line || errorCode || "unknown";
}

/**
 * Groups failing items by the same failed step action and reason; groups of CLUSTER_MIN or more become clusters,
 * the rest stay single. Input order is kept within both lists.
 */
export function clusterFailures<T>(items: T[], causeOf: (item: T) => FailureCause | undefined): { clusters: FailureCluster<T>[]; singles: T[] } {
  const groups = new Map<string, FailureCluster<T>>();
  for (const item of items) {
    const cause = causeOf(item);
    if (!cause) continue;
    const key = `${cause.action ?? ""}\u0000${cause.reason}`;
    const group = groups.get(key) ?? { cause, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const clusters = [...groups.values()].filter((g) => g.items.length >= CLUSTER_MIN).sort((a, b) => b.items.length - a.items.length);
  const clustered = new Set(clusters.flatMap((c) => c.items));
  return { clusters, singles: items.filter((i) => !clustered.has(i)) };
}

// --- Top failing ---------------------------------------------------------------------------------

export interface TopFailing {
  scenarioId: string;
  scenarioName: string;
  runs: number;
  failures: number;
  lastFailedAt: Date;
}

/** Scenarios (across environments) with TOP_FAILING_MIN_RUNS+ counted runs and a failure: failures, then runs, then name. */
export function topFailing(runs: DashboardRun[]): TopFailing[] {
  const by = new Map<string, TopFailing>();
  for (const r of runs) {
    if (!r.scenarioId || !counts(r.status)) continue;
    const row = by.get(r.scenarioId) ?? { scenarioId: r.scenarioId, scenarioName: r.scenarioName, runs: 0, failures: 0, lastFailedAt: new Date(0) };
    row.runs++;
    if (!passed(r.status)) {
      row.failures++;
      if (r.at > row.lastFailedAt) row.lastFailedAt = r.at;
    }
    by.set(r.scenarioId, row);
  }
  return [...by.values()]
    .filter((r) => r.runs >= TOP_FAILING_MIN_RUNS && r.failures > 0)
    .sort((a, b) => b.failures - a.failures || b.runs - a.runs || a.scenarioName.localeCompare(b.scenarioName))
    .slice(0, TOP_FAILING_LIMIT);
}

// --- Summary -------------------------------------------------------------------------------------

export interface DashboardFire {
  status: "started" | "skipped_overlap" | "missed" | "refused" | "error";
  missedCount: number | null;
}

export interface DashboardSummary {
  passRate: number | null;
  /** Every finished run, cancelled included. */
  runCount: number;
  avgDurationMs: number | null;
  failingNow: number;
  /** Planned times missed (a `missed` row counts its missedCount). */
  missed: number;
  skipped: number;
  refused: number;
}

export function summarize(runs: DashboardRun[], failing: FailingItem[], fires: DashboardFire[]): DashboardSummary {
  const timed = runs.filter((r) => r.durationMs !== null);
  return {
    passRate: passRate(runs),
    runCount: runs.length,
    avgDurationMs: timed.length === 0 ? null : timed.reduce((sum, r) => sum + r.durationMs!, 0) / timed.length,
    failingNow: failing.length,
    missed: fires.filter((f) => f.status === "missed").reduce((sum, f) => sum + (f.missedCount ?? 1), 0),
    skipped: fires.filter((f) => f.status === "skipped_overlap").length,
    refused: fires.filter((f) => f.status === "refused").length,
  };
}
