// Schedule fires (stage 5 contract section 4). One transaction per schedule: row lock and re-read, missed
// stretches, the (schedule, planned time) unique fire row, overlap, run creation, fire notifications and the
// next planned time. Run creation and cron maths are passed in (`scheduleFireDeps` gives the real ones), so
// tests can make creation fail.
import { cronTimesBetween, nextCronTime } from "@defe2end/shared";
import type { GroupRunMode, Prisma, PrismaClient, ScheduleFireStatus } from "./generated/prisma/client.js";
import { SCHEDULER_LOCK } from "./locks.js";
import { createRunsInTx, resolveScenarioRuns, type RunCreateEnv } from "./run-create.js";
import { lockWorkspaceRuns } from "./runs.js";

type Tx = Prisma.TransactionClient;

/** A `nextRunAt` more than this far in the past means the worker was down: nothing runs, all is recorded as missed. */
export const SCHEDULE_GRACE_MS = 2 * 60_000;

export interface ScheduleCron {
  /** First time strictly after `after`, or null. */
  next(expr: string, timezone: string, after: Date): Date | null;
  /** Times in `(after, until]`, oldest first, capped; `truncated` when there were more. */
  between(expr: string, timezone: string, after: Date, until: Date): { times: Date[]; truncated?: boolean };
}

export interface ScheduleRunRequest {
  workspaceId: string;
  scheduleId: string;
  environmentId: string;
  scenarioIds: string[];
  mode: GroupRunMode;
  continueOnFailure: boolean;
}

/**
 * Creates the fire's group run inside `tx` (value subject = the schedule, server only). Throws an error with
 * a string `code` (`variable_missing`, `auth_session_missing`, `queue_full`, …) to refuse.
 */
export type ScheduleRunCreator = (tx: Tx, request: ScheduleRunRequest) => Promise<{ groupRunId: string | null }>;

export interface FireDeps {
  cron: ScheduleCron;
  createRuns: ScheduleRunCreator;
}

/** Codes a refusal can carry; any other throw is recorded as `error(internal)`. */
const REFUSAL_CODES = new Set(["variable_missing", "auth_session_missing", "queue_full", "storage_low", "not_found", "conflict", "invalid_request", "no_scenarios"]);

export interface FireResult {
  scheduleId: string;
  /** Rows written by this fire (the planned one first, then any missed stretch). */
  fires: { id: string; status: ScheduleFireStatus; reasonCode: string | null }[];
}

/**
 * The leader's round: due schedule ids under a try-lock (another worker holding it skips the round), then each
 * fires in its own transaction. The row lock and the unique key keep a fire single even across a leader change.
 */
export async function fireDueSchedules(db: PrismaClient, deps: FireDeps): Promise<FireResult[]> {
  const ids = await db.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${SCHEDULER_LOCK}::bigint) AS locked`;
    if (!lock?.locked) return [];
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Schedule" WHERE enabled AND "nextRunAt" <= now() ORDER BY "nextRunAt" LIMIT 100`;
    return rows.map((r) => r.id);
  });
  const results: FireResult[] = [];
  for (const id of ids) {
    const result = await fireSchedule(db, id, deps);
    if (result) results.push(result);
  }
  return results;
}

/** Fires one schedule if it is still due once its row is locked; null when it isn't (turned off, edited, fired). */
export async function fireSchedule(db: PrismaClient, scheduleId: string, deps: FireDeps): Promise<FireResult | null> {
  return db.$transaction(async (tx) => {
    // Lock order is workspace → Schedule on every path (fire, edit, deleting an environment that cascades here):
    // run creation takes the workspace run lock, so taking it after the row lock could deadlock.
    const owner = await tx.schedule.findUnique({ where: { id: scheduleId }, select: { workspaceId: true } });
    if (!owner) return null;
    await lockWorkspaceRuns(tx, owner.workspaceId);
    const locked = await tx.$queryRaw<{ id: string; now: Date }[]>`SELECT id, now() AS now FROM "Schedule" WHERE id = ${scheduleId} FOR UPDATE`;
    if (locked.length === 0) return null;
    const now = locked[0]!.now;
    const schedule = await tx.schedule.findUniqueOrThrow({ where: { id: scheduleId }, include: { workspace: { select: { slug: true } } } });
    const planned = schedule.nextRunAt;
    if (!schedule.enabled || !planned || planned.getTime() > now.getTime()) return null;

    const fires: FireResult["fires"] = [];
    // A long outage can pass more times than one round records: stop at the last recorded one and let the next
    // round (nextRunAt still due) carry on, so every missed time is recorded.
    const { times: later, truncated } = deps.cron.between(schedule.cron, schedule.timezone, planned, now);
    const late = now.getTime() - planned.getTime() > SCHEDULE_GRACE_MS;
    const insert = async (data: Omit<Prisma.ScheduleFireCreateManyInput, "scheduleId" | "scheduleVersion">) => {
      const { count } = await tx.scheduleFire.createMany({ data: [{ ...data, scheduleId, scheduleVersion: schedule.version }], skipDuplicates: true });
      if (count === 0) return null;
      return tx.scheduleFire.findUniqueOrThrow({ where: { scheduleId_scheduledFor: { scheduleId, scheduledFor: data.scheduledFor as Date } } });
    };
    const missed = async (times: Date[]) => {
      if (times.length === 0) return;
      const row = await insert({ scheduledFor: times[0]!, status: "missed", missedUntil: times.at(-1)!, missedCount: times.length });
      if (row) fires.push({ id: row.id, status: "missed", reasonCode: null });
    };

    if (late) {
      await missed([planned, ...later]);
    } else {
      const fire = await insert({ scheduledFor: planned, status: "started" });
      if (fire) {
        const outcome = await startFire(tx, schedule, deps.createRuns);
        await tx.scheduleFire.update({ where: { id: fire.id }, data: outcome });
        fires.push({ id: fire.id, status: outcome.status, reasonCode: outcome.reasonCode });
      }
      // Only the earliest planned time runs; the ones that also passed meanwhile are one missed stretch.
      await missed(later);
    }

    const base = process.env.PUBLIC_URL?.replace(/\/+$/, "") || null;
    for (const fire of fires) {
      if (fire.status === "missed" || fire.status === "refused" || fire.status === "error") await enqueueFireNotification(tx, schedule, fire.id, base ? `${base}/w/${schedule.workspace.slug}/schedules/${schedule.id}` : null);
    }
    const resumeAfter = truncated && later.length > 0 ? later.at(-1)! : now;
    await tx.schedule.update({ where: { id: scheduleId }, data: { nextRunAt: deps.cron.next(schedule.cron, schedule.timezone, resumeAfter) } });
    return { scheduleId, fires };
  });
}

type ScheduleRow = { id: string; workspaceId: string; environmentId: string; scenarioIds: string[]; tagId: string | null; mode: GroupRunMode; continueOnFailure: boolean; overlap: "skip" | "allow" };

async function startFire(tx: Tx, schedule: ScheduleRow, createRuns: ScheduleRunCreator): Promise<{ status: ScheduleFireStatus; reasonCode: string | null; groupRunId?: string | null }> {
  if (schedule.overlap === "skip" && (await tx.run.count({ where: { scheduleId: schedule.id, status: { in: ["queued", "running"] } } })) > 0) {
    return { status: "skipped_overlap", reasonCode: null };
  }
  const scenarioIds = schedule.tagId ? await taggedScenarioIds(tx, schedule) : schedule.scenarioIds;
  if (scenarioIds.length === 0) return { status: "refused", reasonCode: "no_scenarios" };
  // A savepoint, so a refused creation leaves no half-made rows while the fire row itself stays.
  await tx.$executeRaw`SAVEPOINT schedule_fire`;
  try {
    const created = await createRuns(tx, { workspaceId: schedule.workspaceId, scheduleId: schedule.id, environmentId: schedule.environmentId, scenarioIds, mode: schedule.mode, continueOnFailure: schedule.continueOnFailure });
    await tx.$executeRaw`RELEASE SAVEPOINT schedule_fire`;
    return { status: "started", reasonCode: null, groupRunId: created.groupRunId };
  } catch (err) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT schedule_fire`;
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && REFUSAL_CODES.has(code)) return { status: "refused", reasonCode: code };
    console.error(`schedule ${schedule.id}: fire failed`, (err as Error).message);
    return { status: "error", reasonCode: "internal" };
  }
}

/** The tag's unarchived scenarios of the environment's site, oldest first. */
async function taggedScenarioIds(tx: Tx, schedule: ScheduleRow): Promise<string[]> {
  const environment = await tx.environment.findUnique({ where: { id: schedule.environmentId }, select: { siteId: true } });
  if (!environment) return [];
  const rows = await tx.scenario.findMany({
    where: { workspaceId: schedule.workspaceId, siteId: environment.siteId, archivedAt: null, tags: { some: { tagId: schedule.tagId! } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** A `scheduleFire` delivery per valid webhook whose sources include `schedule` (same transaction as the fire). */
async function enqueueFireNotification(tx: Tx, schedule: { id: string; name: string; workspaceId: string }, fireId: string, url: string | null): Promise<void> {
  const hooks = await tx.slackWebhook.findMany({ where: { workspaceId: schedule.workspaceId, invalidAt: null, sources: { has: "schedule" } }, select: { id: true } });
  if (hooks.length === 0) return;
  const fire = await tx.scheduleFire.findUniqueOrThrow({ where: { id: fireId } });
  const payload = {
    kind: "scheduleFire",
    scheduleFireId: fire.id,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    status: fire.status,
    reasonCode: fire.reasonCode,
    scheduledFor: fire.scheduledFor.toISOString(),
    missedUntil: fire.missedUntil?.toISOString() ?? null,
    missedCount: fire.missedCount,
    url,
  };
  // skipDuplicates: the (webhook, scheduleFireId) unique key.
  await tx.notificationDelivery.createMany({ data: hooks.map((h) => ({ webhookId: h.id, kind: "scheduleFire" as const, scheduleFireId: fire.id, payload })), skipDuplicates: true });
}

/** The real dependencies: the shared run creation (schedule as value subject, server only) and cron functions. */
export function scheduleFireDeps(env: RunCreateEnv): FireDeps {
  return {
    cron: { next: nextCronTime, between: (expr, timezone, after, until) => cronTimesBetween(expr, timezone, after, until) },
    createRuns: (tx, request) =>
      createRunsInTx(
        tx,
        {
          workspaceId: request.workspaceId,
          subject: { kind: "schedule", scheduleId: request.scheduleId },
          trigger: "schedule",
          requestHash: `schedule:${request.scheduleId}`,
          options: {},
          placement: { location: "server" },
          group: { environmentId: request.environmentId, mode: request.mode, continueOnFailure: request.continueOnFailure },
          resolve: (t) => resolveScenarioRuns(t, request.workspaceId, request.environmentId, request.scenarioIds),
        },
        env,
      ),
  };
}
