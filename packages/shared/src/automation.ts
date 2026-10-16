// Stage 5 shared types: whose values and login session a run uses, and Slack message bodies.
import { z } from "zod";
import { RUN_STATUSES } from "./run-status.js";

/**
 * Whose personal-variable values and login session a run uses (stage 5 contract section 1.1): the requester,
 * or — for unattended runs — the schedule's or the bot token's own. Never falls back to another subject.
 */
export type ValueSubject = { kind: "user"; userId: string } | { kind: "schedule"; scheduleId: string } | { kind: "bot"; botTokenId: string };

export const valueSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), userId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("schedule"), scheduleId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("bot"), botTokenId: z.string().min(1) }),
]);

export const SCHEDULE_FIRE_STATUSES = ["started", "skipped_overlap", "missed", "refused", "error"] as const;
export type ScheduleFireStatus = (typeof SCHEDULE_FIRE_STATUSES)[number];
export const NOTIFY_ON = ["failures", "all", "changes"] as const;
export const NOTIFICATION_SOURCES = ["schedule", "api", "manual"] as const;
export const NOTIFICATION_KINDS = ["run", "group", "scheduleFire", "report", "test"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Where a run came from, as shown in messages (names, never tokens). */
const originSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("schedule"), scheduleId: z.string(), name: z.string() }),
  z.strictObject({ kind: z.literal("bot"), botTokenId: z.string(), name: z.string() }),
  z.strictObject({ kind: z.literal("user"), name: z.string() }),
]);

/** A failed step as shown in a message; `reason` is already masked. */
const failedStepSchema = z.strictObject({ number: z.number().int().min(1), name: z.string(), reason: z.string().nullable() });

/** Message bodies stored in `NotificationDelivery.payload` (no secrets, no webhook URL). */
export const notificationPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("run"),
    runId: z.string(),
    status: z.enum(RUN_STATUSES),
    scenarioName: z.string(),
    environmentName: z.string(),
    origin: originSchema,
    durationMs: z.number().int().min(0).nullable(),
    warningCount: z.number().int().min(0),
    failedStep: failedStepSchema.nullable(),
    url: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("group"),
    groupRunId: z.string(),
    status: z.enum(RUN_STATUSES),
    environmentName: z.string(),
    origin: originSchema,
    durationMs: z.number().int().min(0).nullable(),
    counts: z.record(z.enum(RUN_STATUSES), z.number().int().min(0)),
    /** At most 10. */
    failures: z.array(z.strictObject({ runId: z.string(), scenarioName: z.string(), status: z.enum(RUN_STATUSES), failedStep: failedStepSchema.nullable() })).max(10),
    url: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("scheduleFire"),
    scheduleFireId: z.string(),
    scheduleId: z.string(),
    scheduleName: z.string(),
    status: z.enum(["missed", "refused", "error"]),
    reasonCode: z.string().nullable(),
    scheduledFor: z.iso.datetime(),
    missedUntil: z.iso.datetime().nullable(),
    missedCount: z.number().int().min(1).nullable(),
    /** Where to fix it (the schedule page). */
    url: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("report"),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    total: z.number().int().min(0),
    counts: z.record(z.enum(RUN_STATUSES), z.number().int().min(0)),
    passRate: z.number().min(0).max(1).nullable(),
    newlyFailing: z.array(z.strictObject({ scenarioName: z.string(), environmentName: z.string() })),
    stillFailing: z.array(z.strictObject({ scenarioName: z.string(), environmentName: z.string(), streak: z.number().int().min(2) })),
    schedules: z.strictObject({ missed: z.number().int().min(0), skipped: z.number().int().min(0), refused: z.number().int().min(0), enabled: z.number().int().min(0) }),
    url: z.string().nullable(),
  }),
  z.strictObject({ kind: z.literal("test"), webhookName: z.string() }),
]);
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;
