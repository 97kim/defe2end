// Data of the scenario list page and the scenario detail page (both behind requireWorkspace's `can()`).
import type { Workspace } from "@defe2end/db";
import type { RunStatus } from "@defe2end/shared";
import { getDb } from "./db";
import { scenarioHistory } from "./run-read";
import { RECENT_RUNS, type ScenarioListRow } from "./scenario-list";
import { scenarioInclude, toDetail, toSummary, type ScenarioDetail } from "./scenarios";

export { RECENT_RUNS, type ScenarioListRow };

export async function scenarioListData(workspace: Workspace): Promise<ScenarioListRow[]> {
  const db = getDb();
  const [rows, recent] = await Promise.all([
    db.scenario.findMany({ where: { workspaceId: workspace.id }, include: scenarioInclude, orderBy: [{ createdAt: "desc" }, { id: "asc" }] }),
    // The latest RECENT_RUNS runs of every scenario (test runs have no scenarioId, so they stay out).
    db.$queryRaw<{ id: string; scenarioId: string; status: RunStatus; queuedAt: Date }[]>`
      SELECT id, "scenarioId", status::text AS status, "queuedAt" FROM (
        SELECT id, "scenarioId", status, "queuedAt",
          row_number() OVER (PARTITION BY "scenarioId" ORDER BY "queuedAt" DESC, id DESC) AS n
        FROM "Run" WHERE "workspaceId" = ${workspace.id} AND "scenarioId" IS NOT NULL AND "comparisonId" IS NULL) ranked
      WHERE n <= ${RECENT_RUNS}::int
      ORDER BY "queuedAt" ASC, id ASC`,
  ]);
  const byScenario = new Map<string, ScenarioListRow["recent"]>();
  for (const r of recent) {
    const list = byScenario.get(r.scenarioId) ?? [];
    list.push({ id: r.id, status: r.status, queuedAt: r.queuedAt.toISOString() });
    byScenario.set(r.scenarioId, list);
  }
  return rows.map((row) => ({
    ...toSummary(row),
    summary: row.description.split("\n")[0]?.trim() ?? "",
    updatedByName: row.updatedBy?.name ?? null,
    recent: byScenario.get(row.id) ?? [],
  }));
}

/** Null when the id is not a scenario of this workspace (another workspace's id included): the page 404s. */
export async function scenarioDetailData(
  workspace: Workspace,
  id: string,
): Promise<{ scenario: ScenarioDetail; updatedAt: Date; history: Awaited<ReturnType<typeof scenarioHistory>>; lastTestRunId: string | null } | null> {
  const db = getDb();
  const row = await db.scenario.findFirst({ where: { id, workspaceId: workspace.id }, include: scenarioInclude });
  if (!row) return null;
  const [history, lastTest] = await Promise.all([
    scenarioHistory(workspace.id, row.id),
    // Test runs started from this scenario's editor (kept 24 hours, then deleted by the worker's cleanup).
    db.run.findFirst({ where: { workspaceId: workspace.id, testOfScenarioId: row.id, trigger: "test" }, orderBy: [{ queuedAt: "desc" }, { id: "desc" }], select: { id: true } }),
  ]);
  return { scenario: toDetail(row), updatedAt: row.updatedAt, history, lastTestRunId: lastTest?.id ?? null };
}

/** Sites with their environments, for the editor and the create dialog. */
export function siteOptions(workspace: Workspace) {
  return getDb().site.findMany({
    where: { workspaceId: workspace.id },
    select: { id: true, name: true, environments: { select: { id: true, workspaceId: true, name: true, baseUrl: true, useAuthSession: true }, orderBy: { name: "asc" } } },
    orderBy: { name: "asc" },
  });
}
