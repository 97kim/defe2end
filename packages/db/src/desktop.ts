// Desktop runs (stage 4 contract section 4): dispatch over the device's SSE connection, start, results and
// reconnect reconciliation. Same rules as runs.ts: row lock before the check, DB time, conditional updates,
// and every path that ends a run settles its group.
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { settleGroup } from "./groups.js";
import { enqueueFinishNotifications } from "./notifications.js";
import { dropRunBaselinePins, serverVerdictWarnings } from "./visual-baselines.js";
import { GROUP_CHILD_STARTABLE, isGroupChildStartable, withOwnedRun } from "./runs.js";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

const TERMINAL = ["passed", "failed", "error", "cancelled", "timed_out"];

/**
 * Records a new SSE connection as the device's current one and reconciles (contract section 4.4), in one
 * transaction holding the device row: dispatch locks the same row first, so a dispatch on the old connection
 * either commits before (and is reconciled here) or sees the new connection and sends nothing. Older streams
 * of the device close on their next poll. Returns the runs reconciliation ended.
 */
export async function connectDevice(
  db: Db,
  deviceId: string,
  client: { appVersion: string; runnerVersion: string; capabilities: string[] },
  activeRunIds: string[],
): Promise<{ connectionId: string; connectedAt: Date; ended: string[] }> {
  const connectionId = randomUUID();
  const { connectedAt, rows } = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "DesktopDevice" WHERE id = ${deviceId} FOR UPDATE`;
    const [row] = await tx.$queryRaw<{ connectedAt: Date }[]>`
      UPDATE "DesktopDevice" SET
        "connectionId" = ${connectionId}, "connectedAt" = clock_timestamp(), "lastSeenAt" = clock_timestamp(),
        "appVersion" = ${client.appVersion}, "runnerVersion" = ${client.runnerVersion}, capabilities = ${client.capabilities}::text[]
      WHERE id = ${deviceId}
      RETURNING "connectedAt"`;
    if (!row) throw new Error(`No desktop device ${deviceId}`);
    const ended = await reconcileInTx(tx, deviceId, connectionId, row.connectedAt, activeRunIds);
    await enqueueFinishNotifications(tx, { runIds: ended.filter((r) => !r.groupRunId).map((r) => r.id) });
    return { connectedAt: row.connectedAt, rows: ended };
  });
  for (const groupRunId of new Set(rows.flatMap((r) => (r.groupRunId ? [r.groupRunId] : [])))) await settleGroup(db, groupRunId);
  return { connectionId, connectedAt, ended: rows.map((r) => r.id) };
}

/** Refreshes `lastSeenAt` while this connection is still the current one. False: a newer connection took over. */
export async function touchDeviceConnection(db: Db, deviceId: string, connectionId: string): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE "DesktopDevice" SET "lastSeenAt" = clock_timestamp() WHERE id = ${deviceId} AND "connectionId" = ${connectionId}`;
  return n > 0;
}

export async function isCurrentConnection(db: Db, deviceId: string, connectionId: string): Promise<boolean> {
  const row = await db.desktopDevice.findUnique({ where: { id: deviceId }, select: { connectionId: true } });
  return row?.connectionId === connectionId;
}

/** Queued runs of the device not sent yet whose group lets them start now, oldest first. */
export async function dispatchCandidates(db: Db, deviceId: string, limit = 10): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT r.id FROM "Run" r
    LEFT JOIN "GroupRun" g ON g.id = r."groupRunId"
    WHERE r.status = 'queued' AND r.location = 'desktop' AND r."desktopDeviceId" = ${deviceId} AND r."dispatchedAt" IS NULL
      AND ${GROUP_CHILD_STARTABLE}
    ORDER BY r."queuedAt", r."groupRunId", r."groupIndex", r.id
    LIMIT ${limit}::int`;
  return rows.map((r) => r.id);
}

export interface DispatchedRun {
  id: string;
  workspaceId: string;
  environmentId: string | null;
  groupRunId: string | null;
  groupIndex: number | null;
  trigger: "manual" | "test" | "schedule" | "api";
  requestedById: string | null;
  scheduleId: string | null;
  botTokenId: string | null;
  snapshot: unknown;
  options: unknown;
}

/**
 * Marks one run as sent on `connectionId`, after locking it and re-checking: still queued and unsent, on this
 * device, this connection still current, and its group lets it start. Null when any of that changed.
 */
export async function markDispatched(
  db: Db,
  runId: string,
  deviceId: string,
  connectionId: string,
  opts: {
    /** Re-check against the current connection (e.g. capabilities). A string refuses: the caller ends the run. */
    check?: (tx: Tx, run: { trigger: string; snapshot: unknown; options: unknown; environmentId: string | null; comparisonId: string | null }, capabilities: string[]) => Promise<string | null>;
  } = {},
): Promise<DispatchedRun | { refused: string } | null> {
  return db.$transaction(async (tx) => {
    // Lock order device → run, like connectDevice: a connection change can't interleave with this dispatch.
    const [device] = await tx.$queryRaw<{ connectionId: string | null; capabilities: string[] }[]>`
      SELECT "connectionId", capabilities FROM "DesktopDevice" WHERE id = ${deviceId} FOR SHARE`;
    if (device?.connectionId !== connectionId) return null;
    const [row] = await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT (status = 'queued' AND location = 'desktop' AND "desktopDeviceId" = ${deviceId} AND "dispatchedAt" IS NULL) AS ok
      FROM "Run" WHERE id = ${runId} FOR UPDATE`;
    if (!row?.ok) return null;
    const run = await tx.run.findUniqueOrThrow({ where: { id: runId }, select: { trigger: true, snapshot: true, options: true, environmentId: true, comparisonId: true } });
    if (opts.check) {
      const refusal = await opts.check(tx, run, device.capabilities);
      if (refusal) return { refused: refusal };
    }
    if (!(await isGroupChildStartable(tx, runId))) return null;
    await tx.$executeRaw`UPDATE "Run" SET "dispatchedAt" = clock_timestamp(), "dispatchedConnectionId" = ${connectionId} WHERE id = ${runId}`;
    return tx.run.findUniqueOrThrow({
      where: { id: runId },
      select: { id: true, workspaceId: true, environmentId: true, groupRunId: true, groupIndex: true, trigger: true, requestedById: true, scheduleId: true, botTokenId: true, snapshot: true, options: true },
    });
  });
}

/** Variables were read for the `run` message (contract section 4.1). */
export async function markDesktopVariablesResolved(db: Db, runId: string): Promise<void> {
  await db.$executeRaw`UPDATE "Run" SET "variablesResolvedAt" = clock_timestamp() WHERE id = ${runId}`;
}

/**
 * Ends a queued or running desktop run as `error(code)` unless it ended meanwhile (the conditional update
 * re-checks the status under the row lock, so a completion that committed first wins). Settles its group.
 */
export async function failDesktopRun(db: Db, runId: string, from: ("queued" | "running")[], code: string, message: string): Promise<boolean> {
  const rows = await db.$transaction(async (tx) => {
    const ended = await tx.$queryRaw<{ groupRunId: string | null }[]>`
      UPDATE "Run" SET status = 'error', "errorCode" = ${code}, "errorMessage" = ${message}, "finishedAt" = clock_timestamp(), "leaseExpiresAt" = NULL
      WHERE id = ${runId} AND location = 'desktop' AND status::text = ANY(${from}::text[])
      RETURNING "groupRunId"`;
    if (ended[0] && !ended[0].groupRunId) await enqueueFinishNotifications(tx, { runIds: [runId] });
    return ended;
  });
  if (rows.length === 0) return false;
  if (rows[0]!.groupRunId) await settleGroup(db, rows[0]!.groupRunId);
  return true;
}

export const DESKTOP_RECONNECTED_MESSAGE = "The desktop app reconnected without this run in its queue. It was not retried automatically.";
export const DESKTOP_LOST_MESSAGE = "The desktop app lost this run. It was not retried automatically.";

/**
 * Reconnect reconciliation (contract section 4.4), run by `connectDevice` under the device lock. Only runs
 * sent on an earlier connection are compared with the app's list; unsent queued runs stay. Missing ones end:
 * queued → `desktop_reconnected`, running → `desktop_lost`.
 */
async function reconcileInTx(tx: Tx, deviceId: string, connectionId: string, connectedAt: Date, activeRunIds: string[]) {
  return tx.$queryRaw<{ id: string; groupRunId: string | null }[]>`
    UPDATE "Run" SET
      status = 'error',
      "errorCode" = CASE WHEN status = 'queued' THEN 'desktop_reconnected' ELSE 'desktop_lost' END,
      "errorMessage" = CASE WHEN status = 'queued' THEN ${DESKTOP_RECONNECTED_MESSAGE} ELSE ${DESKTOP_LOST_MESSAGE} END,
      "finishedAt" = clock_timestamp(),
      "leaseExpiresAt" = NULL
    WHERE "desktopDeviceId" = ${deviceId} AND location = 'desktop' AND status IN ('queued', 'running')
      AND "dispatchedAt" IS NOT NULL AND "dispatchedAt" < ${connectedAt}
      AND "dispatchedConnectionId" IS DISTINCT FROM ${connectionId}
      AND NOT (id = ANY(${activeRunIds}::text[]))
    RETURNING id, "groupRunId"`;
}

/** Running runs of the device with a cancel request: the stream sends `stop-run` for each. */
export async function cancelRequestedRuns(db: Db, deviceId: string): Promise<string[]> {
  const rows = await db.run.findMany({
    where: { desktopDeviceId: deviceId, location: "desktop", status: "running", cancelRequestedAt: { not: null } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export type DesktopStartResult =
  | { found: false }
  | { found: true; status: string; claimToken?: string; leaseExpiresAt?: Date; leaseRemainingMs?: number };

/**
 * `POST …/start` (contract section 4.2). Locked, then: sent to this device; a queued run whose group still lets
 * it start becomes `running` with a new claim token; a running run with a live lease returns the same token
 * (the first answer may have been lost); anything else returns its status without a token.
 */
export async function startDesktopRun(db: Db, runId: string, deviceId: string, leaseMs: number): Promise<DesktopStartResult> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Run" WHERE id = ${runId} FOR UPDATE`;
    const [row] = await tx.$queryRaw<{ status: string; groupRunId: string | null; claimToken: string | null; leaseExpiresAt: Date | null; live: boolean; mine: boolean; sent: boolean }[]>`
      SELECT status::text, "groupRunId", "claimToken", "leaseExpiresAt",
        coalesce("leaseExpiresAt" > clock_timestamp(), false) AS live,
        (location = 'desktop' AND "desktopDeviceId" = ${deviceId}) AS mine,
        "dispatchedAt" IS NOT NULL AS sent
      FROM "Run" WHERE id = ${runId}`;
    if (!row?.mine || !row.sent) return { found: false as const };
    if (row.status === "running") {
      if (!row.live) return { found: true as const, status: row.status };
      // A repeated start (the first answer was lost) renews the live lease like a heartbeat, so the app's
      // view of its lease is never longer than the server's.
      const [renewed] = await tx.$queryRaw<{ leaseExpiresAt: Date; leaseRemainingMs: number }[]>`
        UPDATE "Run" SET "heartbeatAt" = clock_timestamp(), "leaseExpiresAt" = clock_timestamp() + ${leaseMs}::int * interval '1 millisecond'
        WHERE id = ${runId}
        RETURNING "leaseExpiresAt", greatest(0, floor(extract(epoch FROM ("leaseExpiresAt" - clock_timestamp())) * 1000))::int AS "leaseRemainingMs"`;
      return { found: true as const, status: row.status, claimToken: row.claimToken!, ...renewed! };
    }
    if (row.status !== "queued" || !(await isGroupChildStartable(tx, runId))) return { found: true as const, status: row.status };
    const claimToken = randomUUID();
    const [started] = await tx.$queryRaw<{ leaseExpiresAt: Date; leaseRemainingMs: number }[]>`
      UPDATE "Run" SET
        status = 'running', "claimToken" = ${claimToken},
        "runnerVersion" = (SELECT "runnerVersion" FROM "DesktopDevice" WHERE id = ${deviceId}),
        "startedAt" = clock_timestamp(), "heartbeatAt" = clock_timestamp(),
        "leaseExpiresAt" = clock_timestamp() + ${leaseMs}::int * interval '1 millisecond'
      WHERE id = ${runId} AND status = 'queued'
      RETURNING "leaseExpiresAt", greatest(0, floor(extract(epoch FROM ("leaseExpiresAt" - clock_timestamp())) * 1000))::int AS "leaseRemainingMs"`;
    if (row.groupRunId) await tx.$executeRaw`UPDATE "GroupRun" SET status = 'running' WHERE id = ${row.groupRunId} AND status = 'queued'`;
    return { found: true as const, status: "running", claimToken, ...started! };
  });
}

/** Extends a live lease; the answer carries the new expiry. */
export async function desktopHeartbeat(db: Db, runId: string, claimToken: string, leaseMs: number): Promise<{ owned: false } | { owned: true; leaseExpiresAt: Date; leaseRemainingMs: number; cancelRequested: boolean }> {
  const result = await withOwnedRun(db, runId, claimToken, async (tx) => {
    const [row] = await tx.$queryRaw<{ leaseExpiresAt: Date; leaseRemainingMs: number; cancelRequested: boolean }[]>`
      UPDATE "Run" SET "heartbeatAt" = clock_timestamp(), "leaseExpiresAt" = clock_timestamp() + ${leaseMs}::int * interval '1 millisecond'
      WHERE id = ${runId}
      RETURNING "leaseExpiresAt", greatest(0, floor(extract(epoch FROM ("leaseExpiresAt" - clock_timestamp())) * 1000))::int AS "leaseRemainingMs", "cancelRequestedAt" IS NOT NULL AS "cancelRequested"`;
    return row!;
  });
  return result.owned ? { owned: true, ...result.value } : result;
}

export interface DesktopStepInput {
  attempt: number;
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
  visualVerdict?: "created" | "match" | "shifted" | "changed" | "size_mismatch" | "skipped" | "incomparable";
  visualDiffPercent?: number;
  visualShiftDiffPercent?: number;
  visualShift?: { x: number; y: number };
  visualBaselineVersionId?: string;
  render?: Prisma.InputJsonValue;
}

async function upsertSteps(tx: Tx, runId: string, steps: DesktopStepInput[]): Promise<void> {
  for (const step of steps) {
    const data = { ...step, startedAt: new Date(step.startedAt) };
    // Visual fields are taken once, when the step is first reported: the server may have settled them since
    // (first-baseline race, verdict check), and a later report must not overwrite that (stage 7 section 4).
    const existing = await tx.stepResult.findUnique({ where: { runId_attempt_index: { runId, attempt: step.attempt, index: step.index } }, select: { visualVerdict: true, status: true, errorCode: true, errorMessage: true } });
    if (existing?.visualVerdict) {
      const { visualVerdict: _v, visualDiffPercent: _d, visualShiftDiffPercent: _s, visualShift: _sh, visualBaselineVersionId: _b, render: _r, ...rest } = data;
      // A screenshot step's warning comes from its visual verdict only, so the stored outcome stands.
      const keep = existing.errorCode === "warning" || rest.errorCode === "warning" ? { status: existing.status, errorCode: existing.errorCode, errorMessage: existing.errorMessage } : {};
      await tx.stepResult.update({ where: { runId_attempt_index: { runId, attempt: step.attempt, index: step.index } }, data: { ...rest, ...keep } });
      continue;
    }
    await tx.stepResult.upsert({ where: { runId_attempt_index: { runId, attempt: step.attempt, index: step.index } }, create: { runId, ...data }, update: data });
  }
}

/** Live step results (best effort); idempotent by (attempt, index). */
export async function recordDesktopSteps(db: Db, runId: string, claimToken: string, steps: DesktopStepInput[]): Promise<boolean> {
  const result = await withOwnedRun(db, runId, claimToken, (tx) => upsertSteps(tx, runId, steps));
  return result.owned;
}

/** A step that started: a `running` placeholder isn't a status we store, so only `attemptCount` moves. */
export async function recordDesktopAttempt(db: Db, runId: string, claimToken: string, attempt: number): Promise<boolean> {
  const result = await withOwnedRun(db, runId, claimToken, (tx) => tx.$executeRaw`UPDATE "Run" SET "attemptCount" = greatest("attemptCount", ${attempt}::int) WHERE id = ${runId}`);
  return result.owned;
}

export interface DesktopFinal {
  status: "passed" | "failed" | "error" | "cancelled" | "timed_out";
  errorCode?: string;
  errorMessage?: string;
  warningCount: number;
  attemptCount: number;
  passedAfterRetry: boolean;
}

export type DesktopCompleteResult = { result: "stored" } | { result: "finalized"; status: string } | { result: "lease_lost" };

/**
 * `POST …/complete`: overwrites every attempt's steps by (attempt, index) and stores the verdict, under the
 * ownership check. A run that already ended answers `finalized` (409 run_finalized for the app).
 */
export async function completeDesktopRun(db: Db, runId: string, claimToken: string, steps: DesktopStepInput[], final: DesktopFinal): Promise<DesktopCompleteResult> {
  const result = await withOwnedRun(db, runId, claimToken, async (tx) => {
    await upsertSteps(tx, runId, steps);
    const [row] = await tx.$queryRaw<{ groupRunId: string | null }[]>`
      UPDATE "Run" SET
        status = ${final.status}::"RunStatus", "errorCode" = ${final.errorCode ?? null}, "errorMessage" = ${final.errorMessage ?? null},
        "warningCount" = ${final.warningCount + (await serverVerdictWarnings(tx, runId))}::int, "attemptCount" = ${final.attemptCount}::int, "passedAfterRetry" = ${final.passedAfterRetry},
        "finishedAt" = clock_timestamp(), "leaseExpiresAt" = NULL
      WHERE id = ${runId}
      RETURNING "groupRunId"`;
    await dropRunBaselinePins(tx, runId);
    if (!row!.groupRunId) await enqueueFinishNotifications(tx, { runIds: [runId] });
    return row!.groupRunId;
  });
  if (result.owned) {
    if (result.value) await settleGroup(db, result.value);
    return { result: "stored" };
  }
  const run = await db.run.findUnique({ where: { id: runId }, select: { status: true } });
  if (run && TERMINAL.includes(run.status)) return { result: "finalized", status: run.status };
  return { result: "lease_lost" };
}

export interface DesktopArtifactKey {
  kind: "screenshot" | "video" | "trace" | "log" | "dom_summary" | "visual_diff" | "a11y_snapshot";
  attempt: number;
  name: string;
  stepIndex?: number;
}

/**
 * Bytes this run's artifacts would total with `sizeBytes` under `key` (an upload under an existing key
 * replaces it, so that one isn't counted twice). Call inside `withOwnedRun` (the run row is locked).
 */
export async function artifactTotalWith(tx: Tx, runId: string, key: DesktopArtifactKey, sizeBytes: number): Promise<number> {
  const [row] = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum("sizeBytes")::bigint AS total FROM "Artifact"
    WHERE "runId" = ${runId} AND NOT (kind::text = ${key.kind} AND attempt = ${key.attempt}::int AND name = ${key.name})`;
  return Number(row?.total ?? 0) + sizeBytes;
}

/**
 * Registers an uploaded file under `key`, replacing an earlier upload of the same key, if the run's total
 * stays within `limitBytes` — checked under the row lock, so concurrent uploads can't both slip under it.
 * Returns the storage keys to delete (the replaced file), or why it was refused.
 */
export async function registerDesktopArtifact(
  db: Db,
  run: { id: string; workspaceId: string; claimToken: string },
  key: DesktopArtifactKey,
  file: { storageKey: string; contentType: string; sizeBytes: number },
  limitBytes: number,
): Promise<{ ok: true; replaced: string[] } | { ok: false; reason: "lease_lost" | "too_large" }> {
  const result = await withOwnedRun(db, run.id, run.claimToken, async (tx) => {
    if ((await artifactTotalWith(tx, run.id, key, file.sizeBytes)) > limitBytes) return null;
    const old = await tx.artifact.findMany({ where: { runId: run.id, kind: key.kind, attempt: key.attempt, name: key.name }, select: { id: true, storageKey: true } });
    if (old.length > 0) await tx.artifact.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    await tx.artifact.create({
      data: { runId: run.id, workspaceId: run.workspaceId, kind: key.kind, attempt: key.attempt, stepIndex: key.stepIndex, name: key.name, ...file },
    });
    return old.map((o) => o.storageKey);
  });
  if (!result.owned) return { ok: false, reason: "lease_lost" };
  if (result.value === null) return { ok: false, reason: "too_large" };
  return { ok: true, replaced: result.value };
}

/** Pre-check before streaming an upload (the real check is in `registerDesktopArtifact`). */
export async function artifactFits(db: Db, run: { id: string; claimToken: string }, key: DesktopArtifactKey, sizeBytes: number, limitBytes: number): Promise<"ok" | "lease_lost" | "too_large"> {
  const result = await withOwnedRun(db, run.id, run.claimToken, async (tx) => (await artifactTotalWith(tx, run.id, key, sizeBytes)) <= limitBytes);
  if (!result.owned) return "lease_lost";
  return result.value ? "ok" : "too_large";
}
