// Run lifecycle (stage 3 contract sections 3 and 4). Every status change of a Run goes through here, so the
// rules hold in one place: short transactions, row lock before the check, DB time (clock_timestamp(), read
// after the lock; now() would be the transaction start) for leases, and conditional updates so a terminal
// status never changes again. Creation lives in the web app (it re-validates the session actor) and takes
// `lockWorkspaceRuns` first. Lock order is always workspace → run.
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { settleGroup } from "./groups.js";
import { enqueueFinishNotifications } from "./notifications.js";
import { RUN_CLAIM_LOCK, RUN_REAPER_LOCK, RUN_WORKSPACE_LOCK_SPACE } from "./locks.js";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;


/** Serializes run creation per workspace (queue length check → insert). Call first in the transaction. */
export async function lockWorkspaceRuns(tx: Tx, workspaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_WORKSPACE_LOCK_SPACE}::int, hashtext(${workspaceId}))`;
}

/**
 * Group start condition, shared by the worker claim, desktop dispatch and desktop start (stage 4 contract
 * section 4.1). Needs `"Run" r` and `LEFT JOIN "GroupRun" g ON g.id = r."groupRunId"` in scope; always true
 * for a run outside a group. A sequential group's child waits until every earlier child has ended — and,
 * without continueOnFailure, passed (stage 3 contract sections 3 and 4.4). Without continueOnFailure, no child
 * of a group with any child already ended non-passed (earlier or later, any mode) starts: the finish commits
 * before its settleGroup, and this check closes that gap.
 */
export const GROUP_CHILD_STARTABLE = Prisma.sql`
  (g.id IS NULL OR g.mode = 'parallel' OR NOT EXISTS (
    SELECT 1 FROM "Run" p
    WHERE p."groupRunId" = r."groupRunId" AND p."groupIndex" < r."groupIndex"
      AND (p.status IN ('queued', 'running') OR (NOT g."continueOnFailure" AND p.status <> 'passed'))))
  AND (g.id IS NULL OR g."continueOnFailure" OR NOT EXISTS (
    SELECT 1 FROM "Run" f
    WHERE f."groupRunId" = r."groupRunId" AND f.status IN ('failed', 'error', 'cancelled', 'timed_out')))`;

/** Whether `GROUP_CHILD_STARTABLE` holds for one run now (e.g. re-checked after locking it). False if missing. */
export async function isGroupChildStartable(tx: Tx | Db, runId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT ${GROUP_CHILD_STARTABLE} AS ok FROM "Run" r
    LEFT JOIN "GroupRun" g ON g.id = r."groupRunId"
    WHERE r.id = ${runId}`;
  return row?.ok ?? false;
}

export interface ClaimOptions {
  workerId: string;
  runnerVersion: string;
  leaseMs: number;
  maxConcurrentRuns: number;
  workspaceConcurrency: number;
  /** Longest wait for the claim lock (ms); past it this round claims nothing. Unset = wait as long as it takes. */
  lockTimeoutMs?: number;
}

export interface ClaimedRun {
  id: string;
  workspaceId: string;
  environmentId: string | null;
  /** Whose login session the run uses when its environment needs one (stage 4 contract section 5). */
  requestedById: string | null;
  /** Unattended origin: the run uses this schedule's or bot token's own values and session (stage 5 section 1.1). */
  scheduleId: string | null;
  botTokenId: string | null;
  claimToken: string;
  snapshot: unknown;
  options: unknown;
  startedAt: Date;
}

/**
 * Takes the oldest queued run, if the global and per-workspace limits allow. The worker checks its own
 * concurrency and free disk before calling. Under the global claim lock the counts can't race;
 * SKIP LOCKED steps over a run whose cancel is being committed right now.
 */
export async function claimNextRun(db: Db, opts: ClaimOptions): Promise<ClaimedRun | null> {
  try {
    return await claimInTransaction(db, opts);
  } catch (err) {
    if (isLockTimeout(err)) return null;
    throw err;
  }
}

/** Postgres `lock_not_available` (55P03): `lock_timeout` ran out. */
function isLockTimeout(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; cause?: unknown; message?: string } | null;
  if (!e) return false;
  return e.code === "55P03" || e.meta?.code === "55P03" || /\b55P03\b|lock timeout/.test(e.message ?? "") || (e.cause !== undefined && isLockTimeout(e.cause));
}

function claimInTransaction(db: Db, opts: ClaimOptions): Promise<ClaimedRun | null> {
  return db.$transaction(async (tx) => {
    if (opts.lockTimeoutMs !== undefined) await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${opts.lockTimeoutMs}ms`}, true)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_CLAIM_LOCK}::bigint)`;
    const [counted] = await tx.$queryRaw<{ running: number }[]>`SELECT count(*)::int AS running FROM "Run" WHERE status = 'running' AND location = 'server'`;
    if ((counted?.running ?? 0) >= opts.maxConcurrentRuns) return null;
    // Oldest first; a group's children in order. Desktop runs are dispatched to their device, never claimed
    // here (stage 4 contract section 4.1); they don't count toward the server limits either.
    const [next] = await tx.$queryRaw<{ id: string; groupRunId: string | null }[]>`
      SELECT r.id, r."groupRunId" FROM "Run" r
      LEFT JOIN "GroupRun" g ON g.id = r."groupRunId"
      WHERE r.status = 'queued' AND r.location = 'server'
        AND r."workspaceId" NOT IN (
          SELECT "workspaceId" FROM "Run" WHERE status = 'running' AND location = 'server'
          GROUP BY "workspaceId" HAVING count(*) >= ${opts.workspaceConcurrency}::int)
        AND ${GROUP_CHILD_STARTABLE}
      ORDER BY r."queuedAt", r."groupRunId", r."groupIndex", r.id
      LIMIT 1
      FOR UPDATE OF r SKIP LOCKED`;
    if (!next) return null;
    const claimToken = randomUUID();
    const [run] = await tx.$queryRaw<Omit<ClaimedRun, "claimToken">[]>`
      UPDATE "Run" SET
        status = 'running',
        "workerId" = ${opts.workerId},
        "claimToken" = ${claimToken},
        "runnerVersion" = ${opts.runnerVersion},
        "startedAt" = clock_timestamp(),
        "heartbeatAt" = clock_timestamp(),
        "leaseExpiresAt" = clock_timestamp() + ${opts.leaseMs}::int * interval '1 millisecond'
      WHERE id = ${next.id} AND status = 'queued'
      RETURNING id, "workspaceId", "environmentId", "requestedById", "scheduleId", "botTokenId", snapshot, options, "startedAt"`;
    if (!run) return null;
    // Lock order under the claim lock: run → group (settleGroup takes the claim lock first, too).
    if (next.groupRunId) await tx.$executeRaw`UPDATE "GroupRun" SET status = 'running' WHERE id = ${next.groupRunId} AND status = 'queued'`;
    return { ...run, claimToken };
  });
}

/**
 * Locks the run row, then checks — after the lock, against DB time — that this worker still owns a live lease.
 * `fn` runs only then, in the same transaction. A worker whose lease expired can't write anything.
 */
export async function withOwnedRun<T>(db: Db, runId: string, claimToken: string, fn: (tx: Tx) => Promise<T>): Promise<{ owned: true; value: T } | { owned: false }> {
  return db.$transaction(async (tx) => {
    // Two statements on purpose: in a `SELECT … FOR UPDATE` the select list is computed before the lock wait,
    // so a clock_timestamp() there would be the time before waiting and let an expired lease through.
    await tx.$queryRaw`SELECT 1 FROM "Run" WHERE id = ${runId} FOR UPDATE`;
    const [row] = await tx.$queryRaw<{ owned: boolean }[]>`
      SELECT (status = 'running' AND "claimToken" = ${claimToken} AND "leaseExpiresAt" > clock_timestamp()) AS owned
      FROM "Run" WHERE id = ${runId}`;
    if (!row?.owned) return { owned: false as const };
    return { owned: true as const, value: await fn(tx) };
  });
}

/** Extends a live lease (never an expired one). Tells the worker whether a cancel was requested. */
export async function heartbeat(db: Db, runId: string, claimToken: string, leaseMs: number): Promise<{ owned: false } | { owned: true; cancelRequested: boolean }> {
  const result = await withOwnedRun(db, runId, claimToken, async (tx) => {
    const [row] = await tx.$queryRaw<{ cancelRequested: boolean }[]>`
      UPDATE "Run" SET
        "heartbeatAt" = clock_timestamp(),
        "leaseExpiresAt" = clock_timestamp() + ${leaseMs}::int * interval '1 millisecond'
      WHERE id = ${runId}
      RETURNING "cancelRequestedAt" IS NOT NULL AS "cancelRequested"`;
    return row!.cancelRequested;
  });
  return result.owned ? { owned: true, cancelRequested: result.value } : result;
}

export async function markVariablesResolved(db: Db, runId: string, claimToken: string): Promise<boolean> {
  const result = await withOwnedRun(db, runId, claimToken, (tx) => tx.$executeRaw`UPDATE "Run" SET "variablesResolvedAt" = clock_timestamp() WHERE id = ${runId}`);
  return result.owned;
}

/**
 * Starts whole-run attempt `attempt` (action spec 4.3) under the ownership check. The run stays `running`
 * between attempts; lease, cancel and overall timeout carry over.
 */
export async function startAttempt(db: Db, runId: string, claimToken: string, attempt: number): Promise<boolean> {
  const result = await withOwnedRun(db, runId, claimToken, (tx) => tx.$executeRaw`UPDATE "Run" SET "attemptCount" = ${attempt}::int WHERE id = ${runId}`);
  return result.owned;
}

/** Fields are already masked by the runner. */
export interface StepResultInput {
  /** Whole-run attempt, from 1. Defaults to 1. */
  attempt?: number;
  index: number;
  stepId: string;
  action: string;
  status: "passed" | "warning" | "failed" | "error" | "cancelled" | "timed_out" | "skipped";
  attempts: number;
  startedAt: string;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  expected?: string;
  actual?: string;
  possibleDuplicate?: boolean;
}

export async function recordStepResult(db: Db, runId: string, claimToken: string, step: StepResultInput): Promise<boolean> {
  const attempt = step.attempt ?? 1;
  const data = { ...step, attempt, startedAt: new Date(step.startedAt) };
  const result = await withOwnedRun(db, runId, claimToken, (tx) =>
    tx.stepResult.upsert({ where: { runId_attempt_index: { runId, attempt, index: step.index } }, create: { runId, ...data }, update: data }),
  );
  return result.owned;
}

export interface ArtifactInput {
  workspaceId: string;
  kind: "screenshot" | "video" | "trace" | "log" | "dom_summary" | "visual_diff" | "a11y_snapshot";
  /** Whole-run attempt, from 1. Defaults to 1. */
  attempt?: number;
  stepIndex?: number;
  name: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
}

/** Registers a stored file. Null when the lease is gone: the caller deletes the file. */
export async function registerArtifact(db: Db, runId: string, claimToken: string, artifact: ArtifactInput): Promise<string | null> {
  const result = await withOwnedRun(db, runId, claimToken, (tx) => tx.artifact.create({ data: { runId, ...artifact }, select: { id: true } }));
  return result.owned ? result.value.id : null;
}

export interface VerdictInput {
  status: "passed" | "failed" | "error" | "cancelled" | "timed_out";
  errorCode?: string;
  errorMessage?: string;
  browserVersion?: string;
  /** Warning steps of the final attempt. */
  warningCount?: number;
  /** The final attempt passed after an earlier one failed. */
  passedAfterRetry?: boolean;
}

/**
 * The final, conditional write. False when the lease was lost: the run was (or will be) ended by the reaper.
 * A group child then lets its group react (stop the rest, or end the group).
 */
export async function finishRun(db: Db, runId: string, claimToken: string, verdict: VerdictInput): Promise<boolean> {
  const result = await withOwnedRun(
    db,
    runId,
    claimToken,
    (tx) => tx.$queryRaw<{ groupRunId: string | null }[]>`
      UPDATE "Run" SET
        status = ${verdict.status}::"RunStatus",
        "errorCode" = ${verdict.errorCode ?? null},
        "errorMessage" = ${verdict.errorMessage ?? null},
        "browserVersion" = ${verdict.browserVersion ?? null},
        "warningCount" = ${verdict.warningCount ?? 0}::int,
        "passedAfterRetry" = ${verdict.passedAfterRetry ?? false},
        "finishedAt" = clock_timestamp(),
        "leaseExpiresAt" = NULL
      WHERE id = ${runId}
      RETURNING "groupRunId"`.then(async (rows) => {
      // A group child's message is its group's (settleGroup); a single run's is decided here, same transaction.
      if (!rows[0]?.groupRunId) await enqueueFinishNotifications(tx, { runIds: [runId] });
      return rows;
    }),
  );
  if (!result.owned) return false;
  const groupRunId = result.value[0]?.groupRunId;
  if (groupRunId) await settleGroup(db, groupRunId);
  return true;
}

export type CancelOutcome = { status: string; cancelRequestedAt: Date | null; finishedAt: Date | null };

/**
 * Cancel (contract section 4.2), under the row lock so a concurrent claim can't slip between read and write.
 * Queued → `cancelled` at once. Running → cancel requested (the worker stops the browser and ends it, unless
 * its verdict commits first). Terminal → unchanged. Repeating returns the same answer. Null: no such run here.
 */
/** `requestedById`: the signed-in person asking (null for bots); a person's cancel sends no finish message. */
export async function requestCancel(db: Db, workspaceId: string, runId: string, requestedById: string | null = null): Promise<CancelOutcome | null> {
  let groupRunId: string | null = null;
  const outcome = await db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ status: string; groupRunId: string | null }[]>`
      SELECT status::text, "groupRunId" FROM "Run" WHERE id = ${runId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    if (!row) return null;
    if (row.status === "queued") {
      await tx.$executeRaw`
        UPDATE "Run" SET status = 'cancelled', "cancelRequestedAt" = clock_timestamp(), "cancelRequestedById" = ${requestedById}, "finishedAt" = clock_timestamp()
        WHERE id = ${runId}`;
      groupRunId = row.groupRunId;
      if (!groupRunId) await enqueueFinishNotifications(tx, { runIds: [runId] });
    } else if (row.status === "running") {
      await tx.$executeRaw`
        UPDATE "Run" SET "cancelRequestedAt" = coalesce("cancelRequestedAt", clock_timestamp()), "cancelRequestedById" = coalesce("cancelRequestedById", ${requestedById})
        WHERE id = ${runId}`;
    }
    return tx.run.findUniqueOrThrow({ where: { id: runId }, select: { status: true, cancelRequestedAt: true, finishedAt: true } });
  });
  if (groupRunId) await settleGroup(db, groupRunId);
  return outcome;
}

/**
 * Ends running runs whose lease expired as `error(worker_lost)` — `error(desktop_lost)` for desktop runs
 * (stage 4 contract section 4.2). Never re-queues them: the target site may
 * already have seen their actions. One reaper at a time (try-lock; others skip this round). The UPDATE
 * re-checks the expiry on each row after locking it, so a heartbeat that just committed wins.
 */
export async function reapExpiredRuns(db: Db): Promise<string[]> {
  const reaped = await db.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${RUN_REAPER_LOCK}::bigint) AS locked`;
    if (!lock?.locked) return [];
    const rows = await tx.$queryRaw<{ id: string; groupRunId: string | null }[]>`
      UPDATE "Run" SET
        status = 'error',
        "errorCode" = CASE WHEN location = 'desktop' THEN 'desktop_lost' ELSE 'worker_lost' END,
        "errorMessage" = CASE WHEN location = 'desktop'
          THEN 'The desktop app stopped renewing its lease. The run was not retried automatically.'
          ELSE 'The worker stopped renewing its lease. The run was not retried automatically.' END,
        "finishedAt" = clock_timestamp(),
        "leaseExpiresAt" = NULL
      WHERE status = 'running' AND "leaseExpiresAt" <= clock_timestamp()
      RETURNING id, "groupRunId"`;
    await enqueueFinishNotifications(tx, { runIds: rows.filter((r) => !r.groupRunId).map((r) => r.id) });
    return rows;
  });
  for (const groupRunId of new Set(reaped.flatMap((r) => (r.groupRunId ? [r.groupRunId] : [])))) await settleGroup(db, groupRunId);
  return reaped.map((r) => r.id);
}
