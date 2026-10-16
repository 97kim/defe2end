import { RUN_TERMINAL_STATUSES, type RunTerminalStatus } from "@defe2end/shared";
import {
  clusterFailures,
  dailySeries,
  failingNow,
  periodRange,
  reasonLine,
  summarize,
  topFailing,
  type DashboardPeriod,
  type DashboardRun,
  type FailureCause,
} from "./dashboard-calc";
import { getDb } from "./db";

// Dashboard data (stage 5 contract section 8): finished, non-test runs queued in the period, plus schedule fires.

export interface DashboardFilter {
  period: DashboardPeriod;
  siteId?: string;
  environmentId?: string;
}

const STEP_FAILURES = ["failed", "error", "timed_out"] as const;

export async function loadDashboard(workspace: { id: string; timezone: string }, filter: DashboardFilter, now = new Date()) {
  const db = getDb();
  const range = periodRange(filter.period, now, workspace.timezone);
  const envWhere = filter.environmentId ? { environmentId: filter.environmentId } : filter.siteId ? { environment: { siteId: filter.siteId } } : {};

  const [rows, fires] = await Promise.all([
    db.run.findMany({
      where: {
        workspaceId: workspace.id,
        trigger: { not: "test" },
        comparisonId: null,
        status: { in: [...RUN_TERMINAL_STATUSES] },
        queuedAt: { gte: range.from, lt: range.to },
        ...envWhere,
      },
      select: {
        id: true,
        scenarioId: true,
        environmentId: true,
        status: true,
        queuedAt: true,
        startedAt: true,
        finishedAt: true,
        attemptCount: true,
        errorCode: true,
        errorMessage: true,
        scenario: { select: { name: true } },
        environment: { select: { name: true, site: { select: { name: true } } } },
      },
    }),
    db.scheduleFire.findMany({
      where: {
        schedule: { workspaceId: workspace.id, ...envWhere },
        scheduledFor: { gte: range.from, lt: range.to },
        status: { in: ["missed", "skipped_overlap", "refused"] },
      },
      select: { status: true, missedCount: true },
    }),
  ]);

  const runs: DashboardRun[] = rows.map((r) => ({
    id: r.id,
    scenarioId: r.scenarioId,
    scenarioName: r.scenario?.name ?? "",
    environmentId: r.environmentId,
    environmentName: r.environment ? `${r.environment.site.name} · ${r.environment.name}` : "",
    status: r.status as RunTerminalStatus,
    at: r.queuedAt,
    durationMs: r.startedAt && r.finishedAt ? Math.max(0, r.finishedAt.getTime() - r.startedAt.getTime()) : null,
  }));
  const failing = failingNow(runs);

  // Cause of each failing item's last run: the first failed step of its final attempt, else the run's own error.
  const lastIds = failing.map((f) => f.lastRunId);
  const steps = lastIds.length
    ? await db.stepResult.findMany({
        where: { runId: { in: lastIds }, status: { in: [...STEP_FAILURES] } },
        select: { runId: true, attempt: true, index: true, action: true, errorCode: true, errorMessage: true },
        orderBy: [{ attempt: "desc" }, { index: "asc" }],
      })
    : [];
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const causes = new Map<string, FailureCause & { stepIndex: number | null }>();
  for (const id of lastIds) {
    const row = rowById.get(id)!;
    const step = steps.find((s) => s.runId === id && s.attempt === Math.max(1, row.attemptCount));
    causes.set(
      id,
      step
        ? { action: step.action, stepIndex: step.index, reason: reasonLine(step.errorCode, step.errorMessage) }
        : { action: null, stepIndex: null, reason: reasonLine(row.errorCode, row.errorMessage) },
    );
  }
  const grouped = clusterFailures(failing, (f) => causes.get(f.lastRunId));

  return {
    range,
    summary: summarize(runs, failing, fires),
    failing: { ...grouped, causes },
    daily: dailySeries(runs, range, workspace.timezone),
    top: topFailing(runs),
  };
}

export type DashboardData = Awaited<ReturnType<typeof loadDashboard>>;
