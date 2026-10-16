// Finish notifications (stage 5 contract sections 3 and 5): every path that ends a run or a group calls
// `enqueueFinishNotifications` in the same transaction, which decides per Slack webhook whether a message is
// due and inserts a `pending` NotificationDelivery. Sending and retries belong to the notification sender.
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

type Tx = Prisma.TransactionClient | PrismaClient;

const TERMINAL = new Set(["passed", "failed", "error", "cancelled", "timed_out"]);
type Source = "schedule" | "api" | "manual";

function publicUrl(): string | null {
  const base = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  return base || null;
}

/** Which origin a run counts as for a webhook's `sources` (test runs never notify). */
function sourceOf(row: { trigger: string; scheduleId: string | null; botTokenId: string | null }): Source | null {
  if (row.trigger === "test") return null;
  if (row.scheduleId || row.trigger === "schedule") return "schedule";
  if (row.botTokenId || row.trigger === "api") return "api";
  return "manual";
}

/**
 * A person cancelled it from a signed-in session (`cancelRequestedById` set by the cancel and stop-all
 * APIs): no message. Bot cancels, group stops, expiries and schedules leave it null, so those still notify.
 */
function cancelledByPerson(row: { status: string; cancelRequestedById: string | null }): boolean {
  return row.status === "cancelled" && row.cancelRequestedById !== null;
}

interface Hook {
  id: string;
  notifyOn: "failures" | "all" | "changes";
  sources: string[];
}

function wants(hook: Hook, source: Source, failing: boolean, changed: () => Promise<boolean>): Promise<boolean> {
  if (!hook.sources.includes(source)) return Promise.resolve(false);
  if (hook.notifyOn === "all") return Promise.resolve(true);
  if (hook.notifyOn === "failures") return Promise.resolve(failing);
  return changed();
}

const firstFailedStep = async (tx: Tx, runId: string) => {
  const step = await tx.stepResult.findFirst({
    where: { runId, status: { in: ["failed", "error", "timed_out"] } },
    orderBy: [{ attempt: "desc" }, { index: "asc" }],
    select: { index: true, action: true, stepId: true, errorMessage: true },
  });
  return step ? { number: step.index + 1, name: step.action, reason: step.errorMessage } : null;
};

async function originOf(tx: Tx, row: { scheduleId: string | null; botTokenId: string | null; requestedById: string | null }) {
  if (row.scheduleId) {
    const s = await tx.schedule.findUnique({ where: { id: row.scheduleId }, select: { name: true } });
    return { kind: "schedule" as const, scheduleId: row.scheduleId, name: s?.name ?? "" };
  }
  if (row.botTokenId) {
    const b = await tx.botToken.findUnique({ where: { id: row.botTokenId }, select: { name: true } });
    return { kind: "bot" as const, botTokenId: row.botTokenId, name: b?.name ?? "" };
  }
  const u = row.requestedById ? await tx.user.findUnique({ where: { id: row.requestedById }, select: { name: true } }) : null;
  return { kind: "user" as const, name: u?.name ?? "" };
}

const snapshotNames = (snapshot: unknown) => {
  const s = snapshot as { scenario?: { name?: string }; environment?: { name?: string } } | null;
  return { scenarioName: s?.scenario?.name ?? "", environmentName: s?.environment?.name ?? "" };
};

const durationOf = (startedAt: Date | null, finishedAt: Date | null) => (startedAt && finishedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : null);

/**
 * Decides and queues the finish messages of these runs and groups (only those that are terminal now; group
 * children are covered by their group's single message). Call inside the transaction that ended them.
 * Returns the number of deliveries created.
 */
export async function enqueueFinishNotifications(tx: Tx, ended: { runIds?: string[]; groupRunIds?: string[] }): Promise<number> {
  let created = 0;
  const base = publicUrl();
  for (const id of new Set(ended.runIds ?? [])) {
    const run = await tx.run.findUnique({ where: { id } });
    if (!run || !TERMINAL.has(run.status) || run.groupRunId) continue;
    const source = sourceOf(run);
    if (!source || cancelledByPerson(run)) continue;
    const hooks = await tx.slackWebhook.findMany({ where: { workspaceId: run.workspaceId, invalidAt: null }, select: { id: true, notifyOn: true, sources: true } });
    if (hooks.length === 0) continue;
    const failing = run.status !== "passed" || run.warningCount > 0;
    const changed = async () => {
      if (!run.scenarioId || !run.environmentId) return true;
      const previous = await tx.run.findFirst({
        where: { id: { not: run.id }, scenarioId: run.scenarioId, environmentId: run.environmentId, status: { in: ["passed", "failed", "error", "cancelled", "timed_out"] }, finishedAt: { lte: run.finishedAt ?? new Date() } },
        orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
        select: { status: true },
      });
      return previous?.status !== run.status;
    };
    let payload: Prisma.InputJsonValue | null = null;
    for (const hook of hooks) {
      if (!(await wants(hook as Hook, source, failing, changed))) continue;
      payload ??= {
        kind: "run",
        runId: run.id,
        status: run.status,
        ...snapshotNames(run.snapshot),
        origin: await originOf(tx, run),
        durationMs: durationOf(run.startedAt, run.finishedAt),
        warningCount: run.warningCount,
        failedStep: await firstFailedStep(tx, run.id),
        url: base ? `${base}/w/${(await tx.workspace.findUnique({ where: { id: run.workspaceId }, select: { slug: true } }))?.slug}/runs/${run.id}` : null,
      };
      // skipDuplicates: the (webhook, runId) unique key makes a repeated finish call a no-op.
      created += (await tx.notificationDelivery.createMany({ data: [{ webhookId: hook.id, kind: "run", runId: run.id, payload }], skipDuplicates: true })).count;
    }
  }
  for (const id of new Set(ended.groupRunIds ?? [])) {
    const group = await tx.groupRun.findUnique({ where: { id }, include: { runs: { orderBy: { groupIndex: "asc" } } } });
    if (!group || !TERMINAL.has(group.status)) continue;
    const trigger = group.runs[0]?.trigger ?? "manual";
    const source = sourceOf({ trigger, scheduleId: group.scheduleId, botTokenId: group.botTokenId });
    if (!source) continue;
    // Same rule for a group: it ended cancelled because a person cancelled a child.
    if (group.status === "cancelled" && group.runs.some((r) => cancelledByPerson(r))) continue;
    const hooks = await tx.slackWebhook.findMany({ where: { workspaceId: group.workspaceId, invalidAt: null }, select: { id: true, notifyOn: true, sources: true } });
    if (hooks.length === 0) continue;
    const failing = group.status !== "passed" || group.runs.some((r) => r.warningCount > 0);
    const changed = async () => {
      // Changed when any child's status differs from the previous finished run of its scenario and environment.
      for (const child of group.runs) {
        if (!child.scenarioId || !child.environmentId) continue;
        const previous = await tx.run.findFirst({
          // Earlier runs outside this group, single runs (groupRunId NULL) included.
          where: { OR: [{ groupRunId: null }, { groupRunId: { not: group.id } }], scenarioId: child.scenarioId, environmentId: child.environmentId, status: { in: ["passed", "failed", "error", "cancelled", "timed_out"] }, finishedAt: { lte: child.finishedAt ?? new Date() } },
          orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
          select: { status: true },
        });
        if (previous?.status !== child.status) return true;
      }
      return false;
    };
    let payload: Prisma.InputJsonValue | null = null;
    for (const hook of hooks) {
      if (!(await wants(hook as Hook, source, failing, changed))) continue;
      if (!payload) {
        const counts: Record<string, number> = {};
        for (const r of group.runs) counts[r.status] = (counts[r.status] ?? 0) + 1;
        const failures = [];
        for (const r of group.runs.filter((x) => x.status !== "passed").slice(0, 10)) {
          failures.push({ runId: r.id, scenarioName: snapshotNames(r.snapshot).scenarioName, status: r.status, failedStep: await firstFailedStep(tx, r.id) });
        }
        const started = group.runs.map((r) => r.startedAt?.getTime()).filter((t): t is number => t !== undefined);
        payload = {
          kind: "group",
          groupRunId: group.id,
          status: group.status,
          environmentName: snapshotNames(group.runs[0]?.snapshot).environmentName,
          origin: await originOf(tx, group),
          durationMs: started.length && group.finishedAt ? Math.max(0, group.finishedAt.getTime() - Math.min(...started)) : null,
          counts,
          failures,
          url: base && group.runs[0] ? `${base}/w/${(await tx.workspace.findUnique({ where: { id: group.workspaceId }, select: { slug: true } }))?.slug}/runs/${group.runs[0].id}` : null,
        };
      }
      // skipDuplicates: the (webhook, groupRunId) unique key makes a repeated finish call a no-op.
      created += (await tx.notificationDelivery.createMany({ data: [{ webhookId: hook.id, kind: "group", groupRunId: group.id, payload }], skipDuplicates: true })).count;
    }
  }
  return created;
}
