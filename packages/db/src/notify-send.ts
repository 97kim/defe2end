// Slack delivery sender and daily reports (stage 5 contract sections 5 and 6).
//
// A delivery is claimed like a run: `sending` + a fresh claimToken + a 30-second lease, `attempts + 1` and the
// attempt's start row, all committed BEFORE the request goes out — a crash mid-send still counts as an attempt.
// The outcome is written only while the claim is still ours and its lease valid (a late result is ignored).
//
// External delivery is AT LEAST ONCE: if Slack accepted a message and the sender died before recording it,
// the lease expires and the message is sent again. Slack may therefore show a duplicate; it never misses one
// while attempts remain.
//
// The webhook URL is decrypted only for the request; it never reaches logs, attempt rows or errors
// (attempts keep the status code and an error code only).
import { randomUUID } from "node:crypto";
import { cronTimesBetween } from "@defe2end/shared";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { NOTIFY_SENDER_LOCK } from "./locks.js";
import { buildSlackMessage, type MessageLocale } from "./notify-message.js";

type Db = PrismaClient;

export const NOTIFY_LIMITS = {
  leaseMs: 30_000,
  requestTimeoutMs: 10_000,
  /** First attempt + 3 retries. */
  maxAttempts: 4,
  /** Wait after attempt 1, 2, 3. */
  retryDelaysMs: [5_000, 30_000, 120_000],
  retryAfterMaxMs: 10 * 60_000,
  claimBatch: 10,
} as const;

/** What one HTTP attempt ended as; `errorCode` is never a URL or a value. */
export interface SendOutcome {
  statusCode: number | null;
  errorCode: "timeout" | "network" | "server_error" | "rate_limited" | "rejected" | null;
  retryAfterMs?: number;
  durationMs: number;
}

export type Poster = (url: string, body: { text: string }, timeoutMs: number) => Promise<{ status: number; retryAfter: string | null }>;

/** The real POST. Errors carry only a code, never the URL. */
export const fetchPoster: Poster = async (url, body, timeoutMs) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  await res.arrayBuffer().catch(() => undefined);
  return { status: res.status, retryAfter: res.headers.get("retry-after") };
};

function parseRetryAfter(raw: string | null): number {
  const s = Number(raw);
  const ms = Number.isFinite(s) && s >= 0 ? s * 1000 : (() => {
    const at = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : NOTIFY_LIMITS.retryDelaysMs[0];
  })();
  return Math.min(ms, NOTIFY_LIMITS.retryAfterMaxMs);
}

/** One POST, classified. Never throws. */
export async function postOnce(post: Poster, url: string, body: { text: string }, timeoutMs: number = NOTIFY_LIMITS.requestTimeoutMs): Promise<SendOutcome> {
  const started = Date.now();
  try {
    const res = await post(url, body, timeoutMs);
    const durationMs = Date.now() - started;
    if (res.status >= 200 && res.status < 300) return { statusCode: res.status, errorCode: null, durationMs };
    if (res.status === 429) return { statusCode: 429, errorCode: "rate_limited", retryAfterMs: parseRetryAfter(res.retryAfter), durationMs };
    if (res.status >= 400 && res.status < 500) return { statusCode: res.status, errorCode: "rejected", durationMs };
    // 5xx and anything unexpected (1xx/3xx: redirects are not followed) are retried.
    return { statusCode: res.status, errorCode: "server_error", durationMs };
  } catch (err) {
    const name = (err as Error)?.name;
    return { statusCode: null, errorCode: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", durationMs: Date.now() - started };
  }
}

/** Next state after an attempt: `sent`, a retry at `retryInMs`, `failed` (out of attempts) or `dead` (4xx). */
export function decide(outcome: SendOutcome, attempts: number): { status: "sent" | "pending" | "failed" | "dead"; retryInMs?: number } {
  if (outcome.errorCode === null) return { status: "sent" };
  if (outcome.errorCode === "rejected") return { status: "dead" };
  if (attempts >= NOTIFY_LIMITS.maxAttempts) return { status: "failed" };
  const retryInMs = outcome.errorCode === "rate_limited" ? (outcome.retryAfterMs ?? NOTIFY_LIMITS.retryDelaysMs[0]) : NOTIFY_LIMITS.retryDelaysMs[Math.min(attempts, 3) - 1]!;
  return { status: "pending", retryInMs };
}

export interface ClaimedDelivery {
  id: string;
  claimToken: string;
  attempts: number;
  payload: unknown;
  webhookId: string;
  urlEncrypted: string;
  workspaceId: string;
  /** Message language of the webhook's workspace. */
  locale: MessageLocale;
}

/** `Workspace.locale`, or English when it is anything other than a supported language. */
export const messageLocale = (value: string | null | undefined): MessageLocale => (value === "ko" ? "ko" : "en");

/** Retry delay in SQL after `attempts` attempts (same table as `retryDelaysMs`). */
const RETRY_DELAY_SQL = Prisma.sql`CASE d.attempts WHEN 1 THEN interval '5 seconds' WHEN 2 THEN interval '30 seconds' ELSE interval '120 seconds' END`;

/**
 * One claim round. Only the worker holding the sender lock claims (others get `[]`); claims are still
 * row-safe on their own (`FOR UPDATE SKIP LOCKED`). Also returns expired `sending` claims to `pending`
 * (attempts left) or `failed`, and ends pending deliveries of webhooks marked invalid as `dead`.
 */
export async function claimDeliveries(db: Db, opts: { leaseMs?: number; limit?: number } = {}): Promise<ClaimedDelivery[]> {
  const leaseMs = opts.leaseMs ?? NOTIFY_LIMITS.leaseMs;
  return db.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${NOTIFY_SENDER_LOCK}::bigint) AS locked`;
    if (!lock?.locked) return [];
    await tx.$executeRaw`
      UPDATE "NotificationDelivery" d SET
        status = CASE WHEN d.attempts >= ${NOTIFY_LIMITS.maxAttempts} THEN 'failed'::"DeliveryStatus" ELSE 'pending'::"DeliveryStatus" END,
        "nextAttemptAt" = clock_timestamp() + ${RETRY_DELAY_SQL},
        "claimToken" = NULL, "leaseExpiresAt" = NULL
      WHERE d.status = 'sending' AND d."leaseExpiresAt" <= clock_timestamp()`;
    await tx.$executeRaw`
      UPDATE "NotificationDelivery" d SET status = 'dead'
      FROM "SlackWebhook" w
      WHERE w.id = d."webhookId" AND w."invalidAt" IS NOT NULL AND d.status = 'pending'`;
    const token = randomUUID();
    const rows = await tx.$queryRaw<{ id: string; attempts: number; payload: unknown; webhookId: string }[]>`
      UPDATE "NotificationDelivery" d SET
        status = 'sending', "claimToken" = ${token},
        "leaseExpiresAt" = clock_timestamp() + ${leaseMs} * interval '1 millisecond',
        attempts = d.attempts + 1
      WHERE d.id IN (
        SELECT x.id FROM "NotificationDelivery" x
        -- A new delivery's nextAttemptAt is Prisma's @default(now()), filled from the app's clock, not the
        -- database's: it equals createdAt until a retry moves it (with the database clock). So a new one is
        -- due at once even when the app's clock runs ahead of the database's.
        WHERE x.status = 'pending' AND x."nextAttemptAt" <= greatest(clock_timestamp(), x."createdAt")
        ORDER BY x."nextAttemptAt", x.id
        LIMIT ${opts.limit ?? NOTIFY_LIMITS.claimBatch}
        FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.attempts, d.payload, d."webhookId"`;
    if (rows.length === 0) return [];
    await tx.notificationAttempt.createMany({ data: rows.map((r) => ({ deliveryId: r.id, attempt: r.attempts })) });
    const hooks = await tx.slackWebhook.findMany({ where: { id: { in: rows.map((r) => r.webhookId) } }, select: { id: true, urlEncrypted: true, workspaceId: true, workspace: { select: { locale: true } } } });
    const byId = new Map(hooks.map((h) => [h.id, h]));
    return rows.map((r) => {
      const hook = byId.get(r.webhookId)!;
      return { ...r, claimToken: token, urlEncrypted: hook.urlEncrypted, workspaceId: hook.workspaceId, locale: messageLocale(hook.workspace.locale) };
    });
  });
}

/**
 * Writes an attempt's outcome. The attempt row is ours alone and always gets its result; the delivery (and
 * the webhook's `invalidAt`) only while our claim holds and its lease has not expired. Returns whether the
 * delivery was updated.
 */
export async function recordOutcome(db: Db, claimed: Pick<ClaimedDelivery, "id" | "claimToken" | "attempts" | "webhookId">, outcome: SendOutcome): Promise<boolean> {
  const next = decide(outcome, claimed.attempts);
  return db.$transaction(async (tx) => {
    await tx.notificationAttempt.updateMany({
      where: { deliveryId: claimed.id, attempt: claimed.attempts },
      data: { durationMs: outcome.durationMs, statusCode: outcome.statusCode, errorCode: outcome.errorCode },
    });
    const updated = await tx.$executeRaw`
      UPDATE "NotificationDelivery" SET
        status = ${next.status}::"DeliveryStatus",
        "claimToken" = NULL, "leaseExpiresAt" = NULL,
        "sentAt" = CASE WHEN ${next.status} = 'sent' THEN clock_timestamp() ELSE "sentAt" END,
        "nextAttemptAt" = clock_timestamp() + ${next.retryInMs ?? 0} * interval '1 millisecond'
      WHERE id = ${claimed.id} AND "claimToken" = ${claimed.claimToken} AND status = 'sending' AND "leaseExpiresAt" > clock_timestamp()`;
    if (updated === 0) return false;
    if (next.status === "dead") await tx.slackWebhook.updateMany({ where: { id: claimed.webhookId, invalidAt: null }, data: { invalidAt: new Date() } });
    return true;
  });
}

export interface SenderDeps {
  decrypt: (ciphertext: string) => string;
  post?: Poster;
  leaseMs?: number;
  timeoutMs?: number;
}

/** Claims due deliveries and sends them one by one. Returns how many were attempted. */
export async function sendDueNotifications(db: Db, deps: SenderDeps): Promise<number> {
  // One claim right before each send: a batch claimed up front would let the later leases expire while the
  // earlier sends run (each may take the full request timeout), and those would be sent again.
  let sent = 0;
  for (; sent < NOTIFY_LIMITS.claimBatch; sent++) {
    const [d] = await claimDeliveries(db, { leaseMs: deps.leaseMs, limit: 1 });
    if (!d) break;
    let outcome: SendOutcome;
    try {
      outcome = await postOnce(deps.post ?? fetchPoster, deps.decrypt(d.urlEncrypted), buildSlackMessage(d.payload, d.locale), deps.timeoutMs);
    } catch {
      // Decryption failed (wrong install key): a network-class error, retried and finally `failed`.
      outcome = { statusCode: null, errorCode: "network", durationMs: 0 };
    }
    await recordOutcome(db, d, outcome);
  }
  return sent;
}

/**
 * Test send (contract section 5): straight to this webhook, no queue and no retry. Leaves a `test` delivery
 * with its one attempt so it shows in the history; a 4xx marks the webhook invalid like a real send.
 */
export async function sendTestNotification(db: Db, webhookId: string, deps: SenderDeps): Promise<{ deliveryId: string; status: "sent" | "failed" | "dead"; statusCode: number | null; errorCode: SendOutcome["errorCode"] }> {
  const hook = await db.slackWebhook.findUniqueOrThrow({ where: { id: webhookId }, include: { workspace: { select: { locale: true } } } });
  const payload = { kind: "test", webhookName: hook.name };
  const delivery = await db.notificationDelivery.create({
    data: { webhookId, kind: "test", payload, status: "sending", attempts: 1, attemptRows: { create: { attempt: 1 } } },
  });
  let outcome: SendOutcome;
  try {
    outcome = await postOnce(deps.post ?? fetchPoster, deps.decrypt(hook.urlEncrypted), buildSlackMessage(payload, messageLocale(hook.workspace.locale)), deps.timeoutMs);
  } catch {
    outcome = { statusCode: null, errorCode: "network", durationMs: 0 };
  }
  const status = outcome.errorCode === null ? "sent" : outcome.errorCode === "rejected" ? "dead" : "failed";
  await db.$transaction(async (tx) => {
    await tx.notificationAttempt.updateMany({ where: { deliveryId: delivery.id, attempt: 1 }, data: { durationMs: outcome.durationMs, statusCode: outcome.statusCode, errorCode: outcome.errorCode } });
    await tx.notificationDelivery.update({ where: { id: delivery.id }, data: { status, sentAt: status === "sent" ? new Date() : null } });
    if (status === "dead") await tx.slackWebhook.updateMany({ where: { id: webhookId, invalidAt: null }, data: { invalidAt: new Date() } });
  });
  return { deliveryId: delivery.id, status, statusCode: outcome.statusCode, errorCode: outcome.errorCode };
}

// --- Daily reports (contract section 6) ---------------------------------------------------------------

/** UTC instant of wall-clock `y-m-d hh:mm` in `timeZone` (DST gaps move forward, overlaps take the first). */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - t;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t);
}

/** The latest report time (`HH:MM` in `timeZone`) at or before `now`. */
export function latestReportTime(now: Date, reportTime: string, timeZone: string): Date {
  const [hh, mm] = reportTime.split(":").map(Number) as [number, number];
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-").map(Number) as [number, number, number];
  let [y, m, d] = parts;
  for (let i = 0; i < 3; i++) {
    const at = zonedTime(y, m, d, hh, mm, timeZone);
    if (at.getTime() <= now.getTime()) return at;
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    [y, m, d] = [prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate()];
  }
  throw new Error("no report time found");
}

/**
 * How many planned times of a missed stretch `[scheduledFor, missedUntil]` (`missedCount` times) fall in
 * `[from, to)`. Whole stretch inside: `missedCount`. Partly inside: the schedule's cron recounts the times in
 * the overlap — exact while the schedule still has the version that recorded the stretch (same cron and time
 * zone). If it was edited since, the count is prorated by the overlap's share of the stretch (an estimate).
 */
export function missedInWindow(
  f: { scheduledFor: Date; missedUntil: Date | null; missedCount: number | null; scheduleVersion: number; schedule: { cron: string; timezone: string; version: number } },
  from: Date,
  to: Date,
): number {
  const first = f.scheduledFor.getTime();
  const last = (f.missedUntil ?? f.scheduledFor).getTime();
  const count = f.missedCount ?? 1;
  if (first >= from.getTime() && last < to.getTime()) return count;
  const lo = Math.max(first, from.getTime());
  const hi = Math.min(last, to.getTime() - 1);
  if (lo > hi) return 0;
  if (f.schedule.version === f.scheduleVersion) {
    try {
      const { times, truncated } = cronTimesBetween(f.schedule.cron, f.schedule.timezone, new Date(lo - 1), new Date(hi), count);
      if (!truncated) return times.length;
    } catch {
      // Unreadable cron: fall through to the estimate.
    }
  }
  if (last === first || count < 2) return count;
  // Planned times assumed evenly spaced over the stretch: first + k·step, k = 0 … count − 1.
  const step = (last - first) / (count - 1);
  const k0 = Math.max(0, Math.ceil((lo - first) / step));
  const k1 = Math.min(count - 1, Math.floor((hi - first) / step));
  return Math.max(0, k1 - k0 + 1);
}

const FAILING = ["failed", "error", "timed_out"];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Report numbers for `[from, to)` of a workspace (test runs excluded). */
export async function buildReportPayload(tx: Prisma.TransactionClient | Db, workspaceId: string, from: Date, to: Date) {
  const runs = await tx.run.findMany({
    where: { workspaceId, trigger: { not: "test" }, status: { in: ["passed", "failed", "error", "cancelled", "timed_out"] }, finishedAt: { gte: from, lt: to } },
    select: { status: true, scenarioId: true, environmentId: true, finishedAt: true, snapshot: true },
    orderBy: [{ finishedAt: "asc" }, { id: "asc" }],
  });
  const counts: Record<string, number> = {};
  for (const r of runs) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const total = runs.length;
  const decided = total - (counts.cancelled ?? 0);
  // Latest run in the window per scenario and environment; failing ones get their streak counted back in time.
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (r.scenarioId && r.environmentId) latest.set(`${r.scenarioId}|${r.environmentId}`, r);
  const newlyFailing: { scenarioName: string; environmentName: string }[] = [];
  const stillFailing: { scenarioName: string; environmentName: string; streak: number }[] = [];
  for (const r of latest.values()) {
    if (!FAILING.includes(r.status)) continue;
    const history = await tx.run.findMany({
      where: { scenarioId: r.scenarioId, environmentId: r.environmentId, trigger: { not: "test" }, status: { in: ["passed", ...FAILING] as never }, finishedAt: { lte: r.finishedAt!, not: null } },
      orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
      select: { status: true },
      take: 50,
    });
    let streak = 0;
    for (const h of history) {
      if (!FAILING.includes(h.status)) break;
      streak++;
    }
    const s = r.snapshot as { scenario?: { name?: string }; environment?: { name?: string } } | null;
    const names = { scenarioName: s?.scenario?.name ?? "", environmentName: s?.environment?.name ?? "" };
    if (streak >= 2) stillFailing.push({ ...names, streak });
    else newlyFailing.push(names);
  }
  const fires = await tx.scheduleFire.findMany({ where: { schedule: { workspaceId }, scheduledFor: { gte: from, lt: to }, status: { in: ["skipped_overlap", "refused"] } }, select: { status: true } });
  const schedules = { missed: 0, skipped: 0, refused: 0, enabled: await tx.schedule.count({ where: { workspaceId, enabled: true } }) };
  for (const f of fires) {
    if (f.status === "skipped_overlap") schedules.skipped++;
    else schedules.refused++;
  }
  // Missed stretches overlapping the window (they may start before it or end after it).
  const missed = await tx.scheduleFire.findMany({
    where: { schedule: { workspaceId }, status: "missed", scheduledFor: { lt: to }, OR: [{ missedUntil: { gte: from } }, { missedUntil: null, scheduledFor: { gte: from } }] },
    select: { scheduledFor: true, missedUntil: true, missedCount: true, scheduleVersion: true, schedule: { select: { cron: true, timezone: true, version: true } } },
  });
  for (const f of missed) schedules.missed += missedInWindow(f, from, to);
  const base = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  const slug = base ? (await tx.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }))?.slug : null;
  return {
    kind: "report" as const,
    from: from.toISOString(),
    to: to.toISOString(),
    total,
    counts,
    passRate: decided > 0 ? (counts.passed ?? 0) / decided : null,
    newlyFailing,
    stillFailing,
    schedules,
    url: base && slug ? `${base}/w/${slug}` : null,
  };
}

/**
 * Creates due daily reports. Per webhook, in one transaction holding the webhook row lock, the last window
 * and this report time are recomputed; the window `[last.to or to − 24h, to)` and its `report` delivery are
 * created together. (webhookId, to) is unique, so two leaders never make the same window twice.
 * Returns the number of reports created.
 */
export async function enqueueDueReports(db: Db, now: Date = new Date()): Promise<number> {
  const hooks = await db.slackWebhook.findMany({ where: { dailyReport: true, invalidAt: null }, select: { id: true } });
  let created = 0;
  for (const { id } of hooks) {
    const made = await db.$transaction(async (tx) => {
      const [hook] = await tx.$queryRaw<{ id: string; workspaceId: string; dailyReport: boolean; invalidAt: Date | null; reportTime: string; reportTimezone: string; createdAt: Date }[]>`
        SELECT id, "workspaceId", "dailyReport", "invalidAt", "reportTime", "reportTimezone", "createdAt" FROM "SlackWebhook" WHERE id = ${id} FOR UPDATE`;
      if (!hook || !hook.dailyReport || hook.invalidAt) return false;
      const to = latestReportTime(now, hook.reportTime, hook.reportTimezone);
      if (to.getTime() <= hook.createdAt.getTime()) return false;
      const last = await tx.reportWindow.findFirst({ where: { webhookId: id }, orderBy: { to: "desc" }, select: { to: true } });
      if (last && last.to.getTime() >= to.getTime()) return false;
      const from = last?.to ?? new Date(to.getTime() - DAY_MS);
      const payload = await buildReportPayload(tx, hook.workspaceId, from, to);
      const delivery = await tx.notificationDelivery.create({ data: { webhookId: id, kind: "report", payload } });
      await tx.reportWindow.create({ data: { webhookId: id, from, to, deliveryId: delivery.id } });
      return true;
    });
    if (made) created++;
  }
  return created;
}
