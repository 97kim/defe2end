import { NOTIFICATION_SOURCES, NOTIFY_ON } from "@defe2end/shared";
import type { SlackWebhook } from "@defe2end/db";
import { z } from "zod";
import { ApiError } from "./api";
import { getDb } from "./db";

const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown time zone");

const fields = {
  name: z.string().trim().min(1).max(80),
  notifyOn: z.enum(NOTIFY_ON),
  sources: z.array(z.enum(NOTIFICATION_SOURCES)).max(3),
  dailyReport: z.boolean(),
  reportTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM"),
  reportTimezone: timeZone,
};
const url = z.string().trim().url().max(500).refine((u) => u.startsWith("https://") || u.startsWith("http://"), "Use an http(s) URL");

export const webhookCreateSchema = z.strictObject({ ...fields, url });
/** `url` empty or missing keeps the stored one; `invalid: false` turns a webhook marked invalid back on. */
export const webhookUpdateSchema = z.strictObject({ ...fields, url: url.or(z.literal("")).optional(), invalid: z.literal(false).optional() }).partial();

/** Never includes the URL: only its last 4 characters. */
export function webhookView(w: SlackWebhook) {
  return {
    id: w.id,
    name: w.name,
    urlHint: w.urlHint,
    notifyOn: w.notifyOn,
    sources: w.sources.filter((s) => s !== "test"),
    dailyReport: w.dailyReport,
    reportTime: w.reportTime,
    reportTimezone: w.reportTimezone,
    invalidAt: w.invalidAt?.toISOString() ?? null,
    createdAt: w.createdAt.toISOString(),
  };
}
export type WebhookView = ReturnType<typeof webhookView>;

export const urlHintOf = (u: string) => u.slice(-4);

export async function findWebhook(workspaceId: string, id: string) {
  const hook = await getDb().slackWebhook.findFirst({ where: { id, workspaceId } });
  if (!hook) throw ApiError.notFound();
  return hook;
}

/** Recent deliveries of a webhook with their attempts (status and error codes only). */
export async function recentDeliveries(webhookId: string, take = 20) {
  const rows = await getDb().notificationDelivery.findMany({
    where: { webhookId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    include: { attemptRows: { orderBy: { attempt: "asc" } } },
  });
  return rows.map((d) => ({
    id: d.id,
    kind: d.kind,
    status: d.status,
    attempts: d.attempts,
    createdAt: d.createdAt.toISOString(),
    sentAt: d.sentAt?.toISOString() ?? null,
    nextAttemptAt: d.status === "pending" ? d.nextAttemptAt.toISOString() : null,
    attemptRows: d.attemptRows.map((a) => ({ attempt: a.attempt, startedAt: a.startedAt.toISOString(), durationMs: a.durationMs, statusCode: a.statusCode, errorCode: a.errorCode })),
  }));
}
export type DeliveryView = Awaited<ReturnType<typeof recentDeliveries>>[number];
