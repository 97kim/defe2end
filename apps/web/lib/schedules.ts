// Schedules (stage 5 contract sections 1.1, 2 and 4): settings, cron check and preview, fire history, the
// schedule's own personal-variable values and its login session status. Edits lock the row the scheduler
// fires under and bump `version`, so a fire never uses half-old settings.
import { lockVariableDefinition, lockWorkspaceRuns, type Prisma, type Schedule, type Variable } from "@defe2end/db";
import { checkCron, CRON_PREVIEW_COUNT, nextCronTime, nextCronTimes, RUN_LIMITS } from "@defe2end/shared";
import { z } from "zod";
import { ApiError } from "./api";
import { audit } from "./audit";
import { getDb } from "./db";
import { encrypt } from "./encryption";

type Tx = Prisma.TransactionClient;

const settingsFields = {
  name: z.string().trim().min(1).max(100),
  environmentId: z.string().min(1),
  /** Exactly one target: these scenarios in order, or every unarchived scenario with the tag at fire time. */
  scenarioIds: z.array(z.string().min(1)).max(RUN_LIMITS.workspaceQueueLength).optional(),
  tagId: z.string().min(1).nullable().optional(),
  mode: z.enum(["sequential", "parallel"]),
  continueOnFailure: z.boolean(),
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().min(1).max(100),
  overlap: z.enum(["skip", "allow"]),
  enabled: z.boolean(),
};

export const createScheduleSchema = z.strictObject({
  ...settingsFields,
  timezone: settingsFields.timezone.optional(),
  overlap: settingsFields.overlap.default("skip"),
  enabled: settingsFields.enabled.default(true),
  mode: settingsFields.mode.default("sequential"),
  continueOnFailure: settingsFields.continueOnFailure.default(true),
});
export const updateScheduleSchema = z.strictObject({
  ...Object.fromEntries(Object.entries(settingsFields).map(([k, v]) => [k, v.optional()])),
  /** Changing the environment deletes the schedule's values; true once the user confirmed. */
  confirmValueReset: z.boolean().optional(),
}) as unknown as z.ZodType<Partial<z.infer<z.ZodObject<typeof settingsFields>>> & { confirmValueReset?: boolean }>;
export const cronPreviewSchema = z.strictObject({ cron: z.string().max(200), timezone: z.string().max(100) });
export const scheduleValueSchema = z.strictObject({ value: z.string().max(10_000) });

export const VALUES_RESET_MESSAGE = "Changing the environment deletes this schedule's own variable values. Confirm to continue.";

/** 400 with the check's code in `reason` and its message. */
function assertCron(cron: string, timezone: string): void {
  const check = checkCron(cron, timezone);
  if (!check.ok) throw new ApiError("invalid_request", check.message, { reason: check.code });
}

/** The next fire times of an expression (preview), or the check's error. */
export function previewCron(cron: string, timezone: string) {
  const check = checkCron(cron, timezone);
  if (!check.ok) return { ok: false as const, code: check.code, message: check.message };
  return { ok: true as const, times: nextCronTimes(cron, timezone, new Date(), CRON_PREVIEW_COUNT).map((t) => t.toISOString()) };
}

/** Targets belong to this workspace and the environment's site: 404 for foreign ids, 400 for another site. */
async function checkTargets(tx: Tx, workspaceId: string, environmentId: string, scenarioIds: string[], tagId: string | null): Promise<void> {
  const environment = await tx.environment.findFirst({ where: { id: environmentId, workspaceId }, select: { siteId: true } });
  if (!environment) throw ApiError.notFound();
  if ((scenarioIds.length > 0) === Boolean(tagId)) throw new ApiError("invalid_request", "Choose scenarios or a tag (one of the two)");
  if (tagId && !(await tx.tag.findFirst({ where: { id: tagId, workspaceId }, select: { id: true } }))) throw ApiError.notFound();
  if (scenarioIds.length > 0) {
    if (new Set(scenarioIds).size !== scenarioIds.length) throw new ApiError("invalid_request", "A scenario is listed twice");
    const rows = await tx.scenario.findMany({ where: { id: { in: scenarioIds }, workspaceId }, select: { siteId: true } });
    if (rows.length !== scenarioIds.length) throw ApiError.notFound();
    if (rows.some((r) => r.siteId !== environment.siteId)) throw new ApiError("invalid_request", "The environment belongs to another site than a scenario");
  }
}

const nextRun = (s: { enabled: boolean; cron: string; timezone: string }) => (s.enabled ? nextCronTime(s.cron, s.timezone, new Date()) : null);

const viewInclude = {
  environment: { select: { name: true, useAuthSession: true } },
  tag: { select: { name: true } },
  fires: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, scheduledFor: true, reasonCode: true, createdAt: true } },
} satisfies Prisma.ScheduleInclude;
type ScheduleWithView = Prisma.ScheduleGetPayload<{ include: typeof viewInclude }>;

export function scheduleView(s: ScheduleWithView) {
  const last = s.fires[0];
  return {
    id: s.id,
    name: s.name,
    environmentId: s.environmentId,
    environmentName: s.environment.name,
    scenarioIds: s.scenarioIds,
    tagId: s.tagId,
    tagName: s.tag?.name ?? null,
    mode: s.mode,
    continueOnFailure: s.continueOnFailure,
    cron: s.cron,
    timezone: s.timezone,
    enabled: s.enabled,
    overlap: s.overlap,
    nextRunAt: s.nextRunAt?.toISOString() ?? null,
    version: s.version,
    lastFire: last ? { status: last.status, reasonCode: last.reasonCode, scheduledFor: last.scheduledFor.toISOString() } : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
export type ScheduleView = ReturnType<typeof scheduleView>;

export async function listSchedules(workspaceId: string): Promise<ScheduleView[]> {
  const rows = await getDb().schedule.findMany({ where: { workspaceId }, include: viewInclude, orderBy: [{ name: "asc" }, { id: "asc" }] });
  return rows.map(scheduleView);
}

export async function getSchedule(workspaceId: string, scheduleId: string): Promise<ScheduleView> {
  const row = await getDb().schedule.findFirst({ where: { id: scheduleId, workspaceId }, include: viewInclude });
  if (!row) throw ApiError.notFound();
  return scheduleView(row);
}

export async function createSchedule(workspace: { id: string; timezone: string }, actorId: string, input: z.infer<typeof createScheduleSchema>): Promise<ScheduleView> {
  const timezone = input.timezone ?? workspace.timezone;
  assertCron(input.cron, timezone);
  const scenarioIds = input.scenarioIds ?? [];
  const tagId = input.tagId ?? null;
  return getDb().$transaction(async (tx) => {
    await checkTargets(tx, workspace.id, input.environmentId, scenarioIds, tagId);
    const row = await tx.schedule.create({
      data: {
        workspaceId: workspace.id,
        name: input.name,
        environmentId: input.environmentId,
        scenarioIds,
        tagId,
        mode: input.mode,
        continueOnFailure: input.continueOnFailure,
        cron: input.cron,
        timezone,
        overlap: input.overlap,
        enabled: input.enabled,
        nextRunAt: nextRun({ ...input, timezone }),
        createdById: actorId,
        updatedById: actorId,
      },
      include: viewInclude,
    });
    await audit({ workspaceId: workspace.id, actorId, action: "schedule.create", targetType: "schedule", targetId: row.id, meta: { name: row.name } }, tx);
    return scheduleView(row);
  });
}

/** Locks the row (the scheduler fires under the same lock), applies the change, bumps `version`, re-plans. */
export async function updateSchedule(workspaceId: string, actorId: string, scheduleId: string, input: Partial<z.infer<typeof createScheduleSchema>> & { confirmValueReset?: boolean }): Promise<ScheduleView> {
  return getDb().$transaction(async (tx) => {
    const current = await lockSchedule(tx, workspaceId, scheduleId);
    const next = {
      name: input.name ?? current.name,
      environmentId: input.environmentId ?? current.environmentId,
      scenarioIds: input.scenarioIds ?? (input.tagId ? [] : current.scenarioIds),
      tagId: input.tagId !== undefined ? input.tagId : input.scenarioIds?.length ? null : current.tagId,
      mode: input.mode ?? current.mode,
      continueOnFailure: input.continueOnFailure ?? current.continueOnFailure,
      cron: input.cron ?? current.cron,
      timezone: input.timezone ?? current.timezone,
      overlap: input.overlap ?? current.overlap,
      enabled: input.enabled ?? current.enabled,
    };
    assertCron(next.cron, next.timezone);
    await checkTargets(tx, workspaceId, next.environmentId, next.scenarioIds, next.tagId);
    const environmentChanged = next.environmentId !== current.environmentId;
    if (environmentChanged) {
      const values = await tx.scheduleVariableValue.count({ where: { scheduleId } });
      if (values > 0 && !input.confirmValueReset) throw new ApiError("conflict", VALUES_RESET_MESSAGE, { reason: "values_reset_required", values });
      await tx.scheduleVariableValue.deleteMany({ where: { scheduleId } });
    }
    // Re-plan only when the timing or the on/off state changed; otherwise keep the planned time.
    const replan = next.cron !== current.cron || next.timezone !== current.timezone || next.enabled !== current.enabled;
    const row = await tx.schedule.update({
      where: { id: scheduleId },
      data: { ...next, version: { increment: 1 }, updatedById: actorId, ...(replan ? { nextRunAt: nextRun(next) } : {}) },
      include: viewInclude,
    });
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k as keyof typeof next]) !== JSON.stringify(current[k as keyof Schedule]));
    await audit({ workspaceId, actorId, action: "schedule.update", targetType: "schedule", targetId: scheduleId, meta: { changed, ...(environmentChanged ? { valuesDeleted: true } : {}) } }, tx);
    return scheduleView(row);
  });
}

export async function deleteSchedule(workspaceId: string, actorId: string, scheduleId: string): Promise<void> {
  await getDb().$transaction(async (tx) => {
    const current = await lockSchedule(tx, workspaceId, scheduleId);
    await tx.schedule.delete({ where: { id: scheduleId } });
    await audit({ workspaceId, actorId, action: "schedule.delete", targetType: "schedule", targetId: scheduleId, meta: { name: current.name } }, tx);
  });
}

/** Workspace run lock, then the row: the same order as the scheduler's fire and environment deletion. */
async function lockSchedule(tx: Tx, workspaceId: string, scheduleId: string): Promise<Schedule> {
  await lockWorkspaceRuns(tx, workspaceId);
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Schedule" WHERE id = ${scheduleId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  if (rows.length === 0) throw ApiError.notFound();
  return tx.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
}

export async function listFires(workspaceId: string, scheduleId: string, limit = 50) {
  await getSchedule(workspaceId, scheduleId);
  const rows = await getDb().scheduleFire.findMany({ where: { scheduleId }, orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(limit, 1), 200),
    // There is no group page: the fire links to the group's first run.
    include: { groupRun: { select: { runs: { orderBy: { groupIndex: "asc" }, take: 1, select: { id: true } } } } },
  });
  return rows.map((f) => ({
    id: f.id,
    scheduledFor: f.scheduledFor.toISOString(),
    status: f.status,
    reasonCode: f.reasonCode,
    missedUntil: f.missedUntil?.toISOString() ?? null,
    missedCount: f.missedCount,
    groupRunId: f.groupRunId,
    runId: f.groupRun?.runs[0]?.id ?? null,
    scheduleVersion: f.scheduleVersion,
    createdAt: f.createdAt.toISOString(),
  }));
}

/** The personal variables of the schedule's environment with the schedule's own value (secrets: `hasValue` only). */
export async function scheduleValues(workspaceId: string, scheduleId: string) {
  const db = getDb();
  const schedule = await db.schedule.findFirst({ where: { id: scheduleId, workspaceId }, select: { environmentId: true, environment: { select: { useAuthSession: true } } } });
  if (!schedule) throw ApiError.notFound();
  const variables = await db.variable.findMany({
    where: { environmentId: schedule.environmentId, scope: "personal" },
    include: { scheduleValues: { where: { scheduleId }, select: { value: true, valueEncrypted: true } } },
    orderBy: { key: "asc" },
  });
  const session = schedule.environment.useAuthSession
    ? await db.authSession.findFirst({ where: { environmentId: schedule.environmentId, scheduleId }, select: { savedAt: true, expiresAt: true } })
    : null;
  return {
    variables: variables.map((v) => {
      const own = v.scheduleValues[0];
      return { id: v.id, key: v.key, isSecret: v.isSecret, hasValue: Boolean(own), ...(own && !v.isSecret ? { value: own.value ?? "" } : {}) };
    }),
    authSession: schedule.environment.useAuthSession
      ? { required: true, savedAt: session?.savedAt.toISOString() ?? null, expiresAt: session?.expiresAt?.toISOString() ?? null, expired: session?.expiresAt ? session.expiresAt.getTime() <= Date.now() : false }
      : { required: false, savedAt: null, expiresAt: null, expired: false },
  };
}

/**
 * The variable row locked, then its definition read again: a concurrent change of the secret flag or scope
 * (which deletes schedule values under the same row) either finishes first and is seen here, or waits for
 * this write and then deletes it — never a plaintext value left on a secret.
 */
async function findScheduleVariable(tx: Tx, workspaceId: string, scheduleId: string, variableId: string): Promise<Variable> {
  const schedule = await tx.schedule.findFirst({ where: { id: scheduleId, workspaceId }, select: { environmentId: true } });
  await lockVariableDefinition(tx, workspaceId, variableId);
  const variable = await tx.variable.findFirst({ where: { id: variableId, workspaceId } });
  if (!schedule || !variable) throw ApiError.notFound();
  if (variable.environmentId !== schedule.environmentId) throw new ApiError("invalid_request", "This variable belongs to another environment than the schedule");
  if (variable.scope !== "personal") throw new ApiError("conflict", "This variable is shared; schedules use its environment value");
  return variable;
}

export async function setScheduleValue(workspaceId: string, actorId: string, scheduleId: string, variableId: string, value: string): Promise<void> {
  await getDb().$transaction(async (tx) => {
    const variable = await findScheduleVariable(tx, workspaceId, scheduleId, variableId);
    if (variable.isSecret && value.length === 0) throw new ApiError("invalid_request", "A secret needs a value");
    const data = variable.isSecret ? { value: null, valueEncrypted: encrypt(value) } : { value, valueEncrypted: null };
    await tx.scheduleVariableValue.upsert({ where: { scheduleId_variableId: { scheduleId, variableId } }, create: { scheduleId, variableId, ...data }, update: data });
    // Never the value.
    await audit({ workspaceId, actorId, action: "schedule.value.set", targetType: "schedule", targetId: scheduleId, meta: { key: variable.key } }, tx);
  });
}

export async function deleteScheduleValue(workspaceId: string, actorId: string, scheduleId: string, variableId: string): Promise<void> {
  await getDb().$transaction(async (tx) => {
    const variable = await findScheduleVariable(tx, workspaceId, scheduleId, variableId);
    await tx.scheduleVariableValue.deleteMany({ where: { scheduleId, variableId } });
    await audit({ workspaceId, actorId, action: "schedule.value.delete", targetType: "schedule", targetId: scheduleId, meta: { key: variable.key } }, tx);
  });
}
