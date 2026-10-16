// Workspace-wide stop and the cleanup jobs (stage 3 contract sections 4.2 and 7).
import type { PrismaClient } from "./generated/prisma/client.js";
import { settleGroup } from "./groups.js";
import { enqueueFinishNotifications } from "./notifications.js";
import { RUN_WORKSPACE_LOCK_SPACE } from "./locks.js";

type Db = PrismaClient;

/**
 * `run.stopAll`: the runs queued or running when the request is committed, nothing created later. The
 * workspace run lock orders it against creation; then each target row is locked like a single cancel, so a
 * claim racing it either sees `cancelled` or carries the cancel request.
 */
export async function stopAllRuns(db: Db, workspaceId: string, requestedById: string | null = null): Promise<{ cancelled: number; cancelRequested: number }> {
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_WORKSPACE_LOCK_SPACE}::int, hashtext(${workspaceId}))`;
    const targets = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Run" WHERE "workspaceId" = ${workspaceId} AND status IN ('queued', 'running') ORDER BY id FOR UPDATE`;
    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return { cancelled: [], cancelRequested: 0 };
    const cancelled = await tx.$queryRaw<{ id: string; groupRunId: string | null }[]>`
      UPDATE "Run" SET status = 'cancelled', "cancelRequestedAt" = coalesce("cancelRequestedAt", clock_timestamp()),
        "cancelRequestedById" = coalesce("cancelRequestedById", ${requestedById}), "finishedAt" = clock_timestamp()
      WHERE id = ANY(${ids}) AND status = 'queued'
      RETURNING id, "groupRunId"`;
    await enqueueFinishNotifications(tx, { runIds: cancelled.filter((r) => !r.groupRunId).map((r) => r.id) });
    const requested = await tx.$executeRaw`
      UPDATE "Run" SET "cancelRequestedAt" = coalesce("cancelRequestedAt", clock_timestamp()), "cancelRequestedById" = coalesce("cancelRequestedById", ${requestedById})
      WHERE id = ANY(${ids}) AND status = 'running'`;
    return { cancelled, cancelRequested: requested };
  });
  for (const groupRunId of new Set(result.cancelled.flatMap((r) => (r.groupRunId ? [r.groupRunId] : [])))) await settleGroup(db, groupRunId);
  return { cancelled: result.cancelled.length, cancelRequested: result.cancelRequested };
}

/**
 * Pre-save test runs are kept for `keepMs` (24 hours) after they end, then deleted with their artifacts.
 * Rows go first and the caller deletes the returned files; a crash in between leaves files the orphan sweep
 * removes. Batched so one call stays short.
 */
export async function deleteExpiredTestRuns(db: Db, keepMs: number, batch = 100): Promise<{ runIds: string[]; storageKeys: string[] }> {
  return db.$transaction(async (tx) => {
    const runs = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Run"
      WHERE trigger = 'test' AND status NOT IN ('queued', 'running')
        AND "finishedAt" < clock_timestamp() - ${keepMs}::bigint * interval '1 millisecond'
      ORDER BY "finishedAt" LIMIT ${batch}::int
      FOR UPDATE SKIP LOCKED`;
    const runIds = runs.map((r) => r.id);
    if (runIds.length === 0) return { runIds, storageKeys: [] };
    const artifacts = await tx.artifact.findMany({ where: { runId: { in: runIds } }, select: { storageKey: true } });
    await tx.run.deleteMany({ where: { id: { in: runIds } } });
    return { runIds, storageKeys: artifacts.map((a) => a.storageKey) };
  });
}

/** Of these storage keys, the ones no Artifact or Attachment row refers to. */
export async function findUnregisteredKeys(db: Db, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const known = await db.$queryRaw<{ storageKey: string }[]>`
    SELECT "storageKey" FROM "Artifact" WHERE "storageKey" = ANY(${keys})
    UNION SELECT "storageKey" FROM "Attachment" WHERE "storageKey" = ANY(${keys})`;
  const registered = new Set(known.map((k) => k.storageKey));
  return keys.filter((k) => !registered.has(k));
}

/**
 * `/api/v1` idempotency keys older than `ttlMs` (stage 5 contract section 7). DELETE locks each row, so it
 * never overlaps a creation that holds the same key row; a deleted key is a new request afterwards.
 */
export async function deleteExpiredApiIdempotency(db: Db, ttlMs: number, now = new Date()): Promise<number> {
  const { count } = await db.apiIdempotency.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - ttlMs) } } });
  return count;
}
