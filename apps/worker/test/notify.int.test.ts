import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildReportPayload, claimDeliveries, enqueueDueReports, missedInWindow, requestCancel, settleGroup, enqueueFinishNotifications, latestReportTime, NOTIFY_LIMITS, recordOutcome, sendDueNotifications, sendTestNotification } from "@defe2end/db";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "@defe2end/shared/server";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { describeDb, getDb, resetDatabase, seedGroup, seedRun } from "./helpers.js";

const key = parseEncryptionKey(process.env.DEFE2END_ENCRYPTION_KEY);
const decrypt = (c: string) => decryptSecret(c, key);

/** Fake Slack: answers from `replies` in order (then 200), records every body. */
let server: Server;
let baseUrl = "";
let replies: { status: number; headers?: Record<string, string>; hangMs?: number }[] = [];
let bodies: { path: string; text: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push({ path: req.url ?? "", text: (JSON.parse(raw || "{}") as { text?: string }).text ?? "" });
      const reply = replies.shift() ?? { status: 200 };
      const answer = () => {
        res.writeHead(reply.status, reply.headers);
        res.end(reply.status === 200 ? "ok" : "no");
      };
      if (reply.hangMs) setTimeout(answer, reply.hangMs);
      else answer();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const SECRET_PATH = "/services/T000/B000/s3cr3tPath";

async function seedHook(workspaceId: string, data: Partial<{ notifyOn: "failures" | "all" | "changes"; sources: ("schedule" | "api" | "manual")[]; dailyReport: boolean; reportTime: string; reportTimezone: string; createdAt: Date }> = {}) {
  return getDb().slackWebhook.create({
    data: { workspaceId, name: "alerts", urlEncrypted: encryptSecret(`${baseUrl}${SECRET_PATH}`, key), urlHint: "Path", notifyOn: "all", sources: ["schedule", "api", "manual"], ...data },
  });
}

async function finishedRun(status: "passed" | "failed", opts: { workspaceId?: string; finishedAt?: Date } = {}) {
  const { workspaceId, runId } = await seedRun({ baseUrl: "http://127.0.0.1:9", steps: [{ id: "s1", action: "goto", url: "/" }], workspaceId: opts.workspaceId });
  const finishedAt = opts.finishedAt ?? new Date();
  await getDb().run.update({ where: { id: runId }, data: { status, startedAt: new Date(finishedAt.getTime() - 3000), finishedAt } });
  return { workspaceId, runId };
}

describeDb("Slack notifications", () => {
  beforeEach(async () => {
    await resetDatabase();
    replies = [];
    bodies = [];
  });

  it("queues one delivery when the same run is finished twice", async () => {
    const { workspaceId, runId } = await finishedRun("failed");
    await seedHook(workspaceId);
    const db = getDb();
    expect(await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [runId] }))).toBe(1);
    expect(await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [runId] }))).toBe(0);
    expect(await db.notificationDelivery.count()).toBe(1);
  });

  it("decides by notifyOn and sources", async () => {
    const db = getDb();
    const { workspaceId, runId: passed } = await finishedRun("passed");
    const failures = await seedHook(workspaceId, { notifyOn: "failures" });
    const scheduleOnly = await seedHook(workspaceId, { sources: ["schedule"] });
    const { runId: failed } = await finishedRun("failed", { workspaceId });
    await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [passed, failed] }));
    const rows = await db.notificationDelivery.findMany({ select: { webhookId: true, runId: true } });
    expect(rows).toEqual([{ webhookId: failures.id, runId: failed }]);
    expect(rows.some((r) => r.webhookId === scheduleOnly.id)).toBe(false);
  });

  it("sends, records the attempt and never stores the URL", async () => {
    const db = getDb();
    const { workspaceId, runId } = await finishedRun("failed");
    await seedHook(workspaceId);
    await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [runId] }));
    expect(await sendDueNotifications(db, { decrypt })).toBe(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.path).toBe(SECRET_PATH);
    expect(bodies[0]!.text).toContain("*Failed*");
    const delivery = await db.notificationDelivery.findFirstOrThrow({ include: { attemptRows: true } });
    expect(delivery.status).toBe("sent");
    expect(delivery.attemptRows).toMatchObject([{ attempt: 1, statusCode: 200, errorCode: null }]);
    const stored = JSON.stringify([await db.notificationDelivery.findMany({ include: { attemptRows: true } }), await db.slackWebhook.findMany({ select: { urlHint: true, name: true } })]);
    expect(stored).not.toContain("s3cr3t");
  });

  it("retries 5xx four times in total with growing waits, then fails", async () => {
    const db = getDb();
    const { workspaceId, runId } = await finishedRun("failed");
    await seedHook(workspaceId);
    await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [runId] }));
    replies = Array.from({ length: 4 }, () => ({ status: 503 }));
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      await db.notificationDelivery.updateMany({ data: { nextAttemptAt: new Date(0) } });
      const before = Date.now();
      expect(await sendDueNotifications(db, { decrypt })).toBe(1);
      const d = await db.notificationDelivery.findFirstOrThrow();
      if (i < 3) {
        expect(d.status).toBe("pending");
        waits.push(Math.round((d.nextAttemptAt.getTime() - before) / 1000));
      } else expect(d.status).toBe("failed");
    }
    expect(waits.map((w) => [5, 30, 120].findIndex((x) => Math.abs(x - w) <= 2))).toEqual([0, 1, 2]);
    expect(await db.notificationAttempt.findMany({ orderBy: { attempt: "asc" }, select: { attempt: true, statusCode: true, errorCode: true } })).toEqual(
      [1, 2, 3, 4].map((attempt) => ({ attempt, statusCode: 503, errorCode: "server_error" })),
    );
    expect(await sendDueNotifications(db, { decrypt })).toBe(0);
  });

  it("follows Retry-After on 429 (capped at 10 minutes) within the same attempt budget", async () => {
    const db = getDb();
    const { workspaceId, runId } = await finishedRun("failed");
    await seedHook(workspaceId);
    await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [runId] }));
    replies = [{ status: 429, headers: { "retry-after": "7200" } }];
    const before = Date.now();
    await sendDueNotifications(db, { decrypt });
    const d = await db.notificationDelivery.findFirstOrThrow();
    expect(d.status).toBe("pending");
    expect(d.attempts).toBe(1);
    expect(Math.round((d.nextAttemptAt.getTime() - before) / 1000)).toBeGreaterThanOrEqual(599);
    expect(Math.round((d.nextAttemptAt.getTime() - before) / 1000)).toBeLessThanOrEqual(602);
  });

  it("gives up at once on 4xx and marks the webhook invalid", async () => {
    const db = getDb();
    const { workspaceId, runId } = await finishedRun("failed");
    const hook = await seedHook(workspaceId);
    await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [runId] }));
    replies = [{ status: 404 }];
    await sendDueNotifications(db, { decrypt });
    expect((await db.notificationDelivery.findFirstOrThrow()).status).toBe("dead");
    expect((await db.slackWebhook.findUniqueOrThrow({ where: { id: hook.id } })).invalidAt).not.toBeNull();
    expect(await db.notificationAttempt.findFirstOrThrow()).toMatchObject({ statusCode: 404, errorCode: "rejected" });
  });

  it("counts a timeout as an attempt and retries", async () => {
    const db = getDb();
    const { workspaceId, runId } = await finishedRun("failed");
    await seedHook(workspaceId);
    await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [runId] }));
    replies = [{ status: 200, hangMs: 2_000 }];
    await sendDueNotifications(db, { decrypt, timeoutMs: 300 });
    expect(await db.notificationDelivery.findFirstOrThrow()).toMatchObject({ status: "pending", attempts: 1 });
    expect(await db.notificationAttempt.findFirstOrThrow()).toMatchObject({ statusCode: null, errorCode: "timeout" });
  });

  it("ignores a late result after the lease expired, and returns the expired claim to pending", async () => {
    const db = getDb();
    const { workspaceId, runId } = await finishedRun("failed");
    await seedHook(workspaceId);
    await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [runId] }));
    const [claimed] = await claimDeliveries(db, { leaseMs: 200 });
    expect(claimed).toBeDefined();
    // The start row is committed before any send: a crash here still counts as attempt 1.
    expect(await db.notificationAttempt.findFirstOrThrow()).toMatchObject({ attempt: 1, statusCode: null, durationMs: null });
    await new Promise((r) => setTimeout(r, 400));
    expect(await recordOutcome(db, claimed!, { statusCode: 200, errorCode: null, durationMs: 5 })).toBe(false);
    expect((await db.notificationDelivery.findFirstOrThrow()).status).toBe("sending");
    expect(await claimDeliveries(db)).toEqual([]); // expired claim goes back to pending with a 5-second wait
    expect(await db.notificationDelivery.findFirstOrThrow()).toMatchObject({ status: "pending", claimToken: null, attempts: 1 });
  });

  it("fails an expired claim that used the last attempt", async () => {
    const db = getDb();
    const { workspaceId, runId } = await finishedRun("failed");
    await seedHook(workspaceId);
    await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [runId] }));
    await db.notificationDelivery.updateMany({ data: { attempts: NOTIFY_LIMITS.maxAttempts - 1 } });
    await claimDeliveries(db, { leaseMs: 100 });
    await new Promise((r) => setTimeout(r, 300));
    await claimDeliveries(db);
    expect((await db.notificationDelivery.findFirstOrThrow()).status).toBe("failed");
  });

  it("writes run messages in the workspace language, English for an unknown value", async () => {
    const db = getDb();
    const { workspaceId, runId } = await finishedRun("failed");
    await db.workspace.update({ where: { id: workspaceId }, data: { locale: "ko" } });
    const hook = await seedHook(workspaceId);
    await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [runId] }));
    await sendDueNotifications(db, { decrypt });
    expect(bodies[0]!.text).toContain("*실패*");
    expect(bodies[0]!.text).toContain("환경:");
    await sendTestNotification(db, hook.id, { decrypt });
    expect(bodies[1]!.text).toContain("테스트 메시지");
    await db.workspace.update({ where: { id: workspaceId }, data: { locale: "fr" } });
    await sendTestNotification(db, hook.id, { decrypt });
    expect(bodies[2]!.text).toContain("Test message");
  });

  it("sends a new delivery at once even when the app's clock is ahead of the database's", async () => {
    const db = getDb();
    const { workspaceId, runId } = await finishedRun("failed");
    await seedHook(workspaceId);
    await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [runId] }));
    // What @default(now()) gives when the app's clock is a minute ahead.
    const ahead = new Date(Date.now() + 60_000);
    await db.notificationDelivery.updateMany({ data: { nextAttemptAt: ahead, createdAt: ahead } });
    expect(await sendDueNotifications(db, { decrypt })).toBe(1);
    // A retry wait set by the database clock is still respected.
    await db.notificationDelivery.updateMany({ data: { status: "pending", nextAttemptAt: new Date(Date.now() + 60_000), createdAt: new Date() } });
    expect(await sendDueNotifications(db, { decrypt })).toBe(0);
  });

  it("claims each delivery right before sending it, so slow sends don't let later claims expire", async () => {
    const db = getDb();
    const { workspaceId } = await finishedRun("passed");
    await seedHook(workspaceId);
    for (let i = 0; i < 5; i++) {
      const { runId } = await finishedRun("failed", { workspaceId });
      await db.$transaction((tx) => enqueueFinishNotifications(tx, { runIds: [runId] }));
    }
    // Each send takes longer than half the lease: a batch claimed up front would expire before its turn.
    let posts = 0;
    const slow = async () => {
      posts++;
      await new Promise((r) => setTimeout(r, 250));
      return { status: 200, retryAfter: null };
    };
    expect(await sendDueNotifications(db, { decrypt, post: slow, leaseMs: 400 })).toBe(5);
    expect(posts).toBe(5);
    expect(await db.notificationDelivery.findMany({ select: { status: true, attempts: true } })).toEqual(Array.from({ length: 5 }, () => ({ status: "sent", attempts: 1 })));
    await claimDeliveries(db);
    expect(await sendDueNotifications(db, { decrypt, post: slow })).toBe(0);
  });

  it("changes: a group child compares with the previous single run too", async () => {
    const db = getDb();
    const { workspaceId, groupRunId, runIds } = await seedGroup({ size: 1, mode: "sequential", continueOnFailure: true });
    await seedHook(workspaceId, { notifyOn: "changes" });
    const child = await db.run.findUniqueOrThrow({ where: { id: runIds[0]! } });
    // An earlier single (non-group) run of the same scenario and environment that failed.
    await db.run.create({ data: { workspaceId, scenarioId: child.scenarioId, environmentId: child.environmentId, trigger: "manual", snapshot: child.snapshot as object, status: "failed", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(Date.now() - 50_000) } });
    await db.run.update({ where: { id: child.id }, data: { status: "failed", startedAt: new Date(Date.now() - 5_000), finishedAt: new Date() } });
    await db.groupRun.update({ where: { id: groupRunId }, data: { status: "failed", finishedAt: new Date() } });
    expect(await db.$transaction((tx) => enqueueFinishNotifications(tx, { groupRunIds: [groupRunId] }))).toBe(0);
  });

  it("a person's cancel of a scheduled run or group sends nothing; a bot's cancel still notifies", async () => {
    const db = getDb();
    const user = await db.user.create({ data: { id: `u-${Date.now()}`, name: "Kim", email: `kim-${Date.now()}@example.com` } });
    const scheduledRun = async (workspaceId?: string) => {
      const seeded = await seedRun({ baseUrl: "http://127.0.0.1:9", steps: [{ id: "s1", action: "goto", url: "/" }], workspaceId });
      await db.run.update({ where: { id: seeded.runId }, data: { trigger: "schedule" } });
      return seeded;
    };
    const { workspaceId, runId: byPerson } = await scheduledRun();
    await seedHook(workspaceId);
    await requestCancel(db, workspaceId, byPerson, user.id);
    expect(await db.notificationDelivery.count({ where: { runId: byPerson } })).toBe(0);
    const { runId: byBot } = await scheduledRun(workspaceId);
    await requestCancel(db, workspaceId, byBot, null);
    expect(await db.notificationDelivery.count({ where: { runId: byBot } })).toBe(1);

    for (const [who, expected] of [[user.id, 0], [null, 1]] as const) {
      const g = await seedGroup({ size: 2, mode: "parallel", continueOnFailure: true });
      await seedHook(g.workspaceId);
      await db.run.updateMany({ where: { groupRunId: g.groupRunId }, data: { trigger: "schedule" } });
      for (const id of g.runIds) await requestCancel(db, g.workspaceId, id, who);
      await settleGroup(db, g.groupRunId);
      expect((await db.groupRun.findUniqueOrThrow({ where: { id: g.groupRunId } })).status).toBe("cancelled");
      expect(await db.notificationDelivery.count({ where: { groupRunId: g.groupRunId } })).toBe(expected);
    }
  });

  it("test send goes straight to the webhook and leaves an attempt", async () => {
    const db = getDb();
    const { workspaceId } = await finishedRun("passed");
    const hook = await seedHook(workspaceId);
    const ok = await sendTestNotification(db, hook.id, { decrypt });
    expect(ok).toMatchObject({ status: "sent", statusCode: 200 });
    replies = [{ status: 500 }];
    expect(await sendTestNotification(db, hook.id, { decrypt })).toMatchObject({ status: "failed", statusCode: 500, errorCode: "server_error" });
    expect(bodies).toHaveLength(2);
    expect(await db.notificationAttempt.count()).toBe(2);
    expect(await db.notificationDelivery.count({ where: { kind: "test", status: "pending" } })).toBe(0);
  });
});

describeDb("daily reports", () => {
  beforeEach(async () => {
    await resetDatabase();
    replies = [];
    bodies = [];
  });

  it("finds the latest report time in a time zone", () => {
    expect(latestReportTime(new Date("2026-10-14T01:00:00Z"), "09:00", "Asia/Seoul").toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(latestReportTime(new Date("2026-10-13T23:59:00Z"), "09:00", "Asia/Seoul").toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(latestReportTime(new Date("2026-03-09T14:00:00Z"), "09:00", "America/New_York").toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  it("makes fixed windows back to back, excludes test runs, and says when nothing ran", async () => {
    const db = getDb();
    const { workspaceId, runId } = await finishedRun("failed", { finishedAt: new Date("2026-10-13T12:00:00Z") });
    await finishedRun("passed", { workspaceId, finishedAt: new Date("2026-10-13T13:00:00Z") });
    const { runId: testRun } = await finishedRun("failed", { workspaceId, finishedAt: new Date("2026-10-13T14:00:00Z") });
    await db.run.update({ where: { id: testRun }, data: { trigger: "test" } });
    expect(runId).toBeTruthy();
    await seedHook(workspaceId, { dailyReport: true, reportTime: "09:00", reportTimezone: "UTC", createdAt: new Date("2026-10-01T00:00:00Z") });

    expect(await enqueueDueReports(db, new Date("2026-10-14T09:30:00Z"))).toBe(1);
    expect(await enqueueDueReports(db, new Date("2026-10-14T09:31:00Z"))).toBe(0);
    const first = await db.reportWindow.findFirstOrThrow({ include: { delivery: true } });
    expect([first.from.toISOString(), first.to.toISOString()]).toEqual(["2026-10-13T09:00:00.000Z", "2026-10-14T09:00:00.000Z"]);
    expect(first.delivery.payload).toMatchObject({ kind: "report", total: 2, counts: { failed: 1, passed: 1 }, passRate: 0.5 });

    // Two days later: the next window starts where the last one ended.
    expect(await enqueueDueReports(db, new Date("2026-10-16T10:00:00Z"))).toBe(1);
    const second = await db.reportWindow.findFirstOrThrow({ orderBy: { to: "desc" }, include: { delivery: true } });
    expect([second.from.toISOString(), second.to.toISOString()]).toEqual(["2026-10-14T09:00:00.000Z", "2026-10-16T09:00:00.000Z"]);
    expect(second.delivery.payload).toMatchObject({ total: 0 });
    await db.schedule.create({ data: { workspaceId, name: "nightly", environmentId: (await db.environment.findFirstOrThrow()).id, cron: "0 3 * * *", timezone: "UTC" } });
    await db.notificationDelivery.updateMany({ where: { id: first.deliveryId }, data: { status: "sent" } });
    expect(await enqueueDueReports(db, new Date("2026-10-17T10:00:00Z"))).toBe(1);
    expect(await sendDueNotifications(db, { decrypt })).toBe(2);
    const third = bodies.find((b) => b.text.includes("2026-10-16 09:00 – 2026-10-17 09:00"));
    expect(third?.text).toContain("1 schedule(s) are enabled");
  });

  it("writes the report in the workspace language", async () => {
    const db = getDb();
    const { workspaceId } = await finishedRun("failed", { finishedAt: new Date("2026-10-13T12:00:00Z") });
    await db.workspace.update({ where: { id: workspaceId }, data: { locale: "ko" } });
    await seedHook(workspaceId, { dailyReport: true, reportTime: "09:00", reportTimezone: "UTC", createdAt: new Date("2026-10-01T00:00:00Z") });
    expect(await enqueueDueReports(db, new Date("2026-10-14T09:30:00Z"))).toBe(1);
    await sendDueNotifications(db, { decrypt });
    expect(bodies[0]!.text).toContain("*일일 리포트*");
    expect(bodies[0]!.text).toContain("통과율 0%");
    expect(bodies[0]!.text).toContain("새로 실패");
  });

  it("counts only the missed times of a stretch that fall in the window", async () => {
    const db = getDb();
    const { workspaceId } = await finishedRun("passed", { finishedAt: new Date("2026-10-13T12:00:00Z") });
    const environmentId = (await db.environment.findFirstOrThrow({ where: { workspaceId } })).id;
    const schedule = await db.schedule.create({ data: { workspaceId, name: "nightly", environmentId, cron: "0 0 * * *", timezone: "UTC" } });
    // Missed on the 12th, 13th and 14th at midnight; the window is [13th, 15th).
    await db.scheduleFire.create({ data: { scheduleId: schedule.id, scheduledFor: new Date("2026-10-12T00:00:00Z"), missedUntil: new Date("2026-10-14T00:00:00Z"), missedCount: 3, status: "missed", scheduleVersion: schedule.version } });
    const report = await buildReportPayload(db, workspaceId, new Date("2026-10-13T00:00:00Z"), new Date("2026-10-15T00:00:00Z"));
    expect(report.schedules.missed).toBe(2);
    expect((await buildReportPayload(db, workspaceId, new Date("2026-10-11T00:00:00Z"), new Date("2026-10-12T00:00:00Z"))).schedules.missed).toBe(0);
    expect((await buildReportPayload(db, workspaceId, new Date("2026-10-11T00:00:00Z"), new Date("2026-10-16T00:00:00Z"))).schedules.missed).toBe(3);
    // Edited since (other version): prorated over the stretch.
    const stretch = { scheduledFor: new Date("2026-10-12T00:00:00Z"), missedUntil: new Date("2026-10-14T00:00:00Z"), missedCount: 3, scheduleVersion: 1, schedule: { cron: "0 6 * * *", timezone: "UTC", version: 2 } };
    expect(missedInWindow(stretch, new Date("2026-10-13T00:00:00Z"), new Date("2026-10-15T00:00:00Z"))).toBe(2);
    expect(missedInWindow(stretch, new Date("2026-10-12T12:00:00Z"), new Date("2026-10-13T12:00:00Z"))).toBe(1);
  });

  it("two leaders at once make the same window once", async () => {
    const db = getDb();
    const { workspaceId } = await finishedRun("passed", { finishedAt: new Date("2026-10-13T12:00:00Z") });
    await seedHook(workspaceId, { dailyReport: true, reportTime: "09:00", reportTimezone: "UTC", createdAt: new Date("2026-10-01T00:00:00Z") });
    const now = new Date("2026-10-14T09:30:00Z");
    const results = await Promise.all([enqueueDueReports(db, now), enqueueDueReports(db, now), enqueueDueReports(db, now)]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await db.reportWindow.count()).toBe(1);
    expect(await db.notificationDelivery.count({ where: { kind: "report" } })).toBe(1);
  });
});
