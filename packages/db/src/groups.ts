// Group runs (stage 3 contract section 4.4). The group and its children are created together by the web app;
// from then on every child that ends calls `settleGroup`, which stops the rest when needed and ends the group
// once all children have. Lock order: claim lock → group → its runs (the claim takes claim lock → run → group).
import type { PrismaClient } from "./generated/prisma/client.js";
import { RUN_CLAIM_LOCK } from "./locks.js";
import { enqueueFinishNotifications } from "./notifications.js";

type Db = PrismaClient;

const TERMINAL = ["passed", "failed", "error", "cancelled", "timed_out"] as const;
type Terminal = (typeof TERMINAL)[number];

/** Mixed children: the worst wins, in this order (contract section 4.4). */
const PRIORITY: Terminal[] = ["error", "timed_out", "failed", "cancelled", "passed"];

export function aggregateGroupStatus(children: readonly string[]): Terminal {
  for (const status of PRIORITY) if (children.includes(status)) return status;
  return "passed";
}

export const GROUP_STOPPED_MESSAGE = "An earlier run of the group did not pass, so this one was not started.";

/**
 * After a child ended: without continueOnFailure, a child that did not pass cancels the children not claimed
 * yet (`cancelled(group_stopped)`) and requests cancel for the running ones. When every child has ended, the
 * group gets the aggregate status — computed from the children re-read under the group lock.
 */
export async function settleGroup(db: Db, groupRunId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_CLAIM_LOCK}::bigint)`;
    const [group] = await tx.$queryRaw<{ status: string; continueOnFailure: boolean }[]>`
      SELECT status::text, "continueOnFailure" FROM "GroupRun" WHERE id = ${groupRunId} FOR UPDATE`;
    if (!group || (TERMINAL as readonly string[]).includes(group.status)) return;

    const read = () => tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM "Run" WHERE "groupRunId" = ${groupRunId}`;
    let children = await read();
    const stop = !group.continueOnFailure && children.some((c) => c.status !== "passed" && (TERMINAL as readonly string[]).includes(c.status));
    if (stop) {
      await tx.$executeRaw`
        UPDATE "Run" SET status = 'cancelled', "errorCode" = 'group_stopped', "errorMessage" = ${GROUP_STOPPED_MESSAGE},
          "cancelRequestedAt" = coalesce("cancelRequestedAt", clock_timestamp()), "finishedAt" = clock_timestamp()
        WHERE "groupRunId" = ${groupRunId} AND status = 'queued'`;
      await tx.$executeRaw`
        UPDATE "Run" SET "cancelRequestedAt" = coalesce("cancelRequestedAt", clock_timestamp())
        WHERE "groupRunId" = ${groupRunId} AND status = 'running'`;
      children = await read();
    }
    if (children.length === 0 || children.some((c) => c.status === "queued" || c.status === "running")) return;
    const status = aggregateGroupStatus(children.map((c) => c.status));
    await tx.$executeRaw`UPDATE "GroupRun" SET status = ${status}::"RunStatus", "finishedAt" = clock_timestamp() WHERE id = ${groupRunId}`;
    // The group's one message (its children never send their own), in the transaction that ended it.
    await enqueueFinishNotifications(tx, { groupRunIds: [groupRunId] });
  });
}

/**
 * Safety net for the worker's maintenance loop: settles groups a crash left behind (a child ended but its
 * settle never ran). Cheap when there is nothing to do.
 */
export async function settlePendingGroups(db: Db): Promise<number> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT g.id FROM "GroupRun" g
    WHERE g.status IN ('queued', 'running')
      AND (NOT EXISTS (SELECT 1 FROM "Run" r WHERE r."groupRunId" = g.id AND r.status IN ('queued', 'running'))
        OR (NOT g."continueOnFailure"
          AND EXISTS (SELECT 1 FROM "Run" r WHERE r."groupRunId" = g.id AND r.status IN ('failed', 'error', 'cancelled', 'timed_out'))
          AND EXISTS (SELECT 1 FROM "Run" r WHERE r."groupRunId" = g.id AND (r.status = 'queued' OR (r.status = 'running' AND r."cancelRequestedAt" IS NULL)))))`;
  for (const row of rows) await settleGroup(db, row.id);
  return rows.length;
}
