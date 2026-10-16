// Stage 5 schema constraints (contract section 2) on real Postgres: one owner per login session, one session
// per environment and owner, one fire per schedule and planned time, unique idempotency keys and report windows.
import { beforeEach, expect, it } from "vitest";
import { describeDb, resetDatabase } from "../test/db";
import { workspaceWithRoles } from "../test/helpers";
import { getDb } from "./db";

describeDb("automation schema", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let env: { id: string };
  let schedule: { id: string };
  let bot: { id: string };
  beforeEach(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    env = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://shop.example.com" } });
    const scenario = await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Login", steps: [] } });
    schedule = await db.schedule.create({ data: { workspaceId: ctx.workspace.id, name: "Nightly", environmentId: env.id, scenarioIds: [scenario.id], cron: "0 2 * * *", timezone: "Asia/Seoul" } });
    bot = await db.botToken.create({ data: { workspaceId: ctx.workspace.id, name: "CI", tokenHash: "h1", prefix: "d2e_abcd", scopes: ["runs:create"], expiresAt: new Date(Date.now() + 86_400_000) } });
  });

  const session = (owner: { userId?: string; scheduleId?: string; botTokenId?: string }) =>
    getDb().authSession.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, ...owner, encryptedState: "x", cookieCount: 1, sizeBytes: 1, savedAt: new Date(), expiresAt: new Date(Date.now() + 1000) } });

  it("a login session has exactly one owner, and one per environment and owner", async () => {
    await expect(session({})).rejects.toThrow();
    await expect(session({ userId: ctx.users.EDITOR.id, scheduleId: schedule.id })).rejects.toThrow();
    await session({ userId: ctx.users.EDITOR.id });
    await session({ userId: ctx.users.ADMIN.id });
    await session({ scheduleId: schedule.id });
    await session({ botTokenId: bot.id });
    await expect(session({ scheduleId: schedule.id })).rejects.toThrow();
    await expect(session({ botTokenId: bot.id })).rejects.toThrow();
    await expect(session({ userId: ctx.users.EDITOR.id })).rejects.toThrow();
    expect(await getDb().authSession.count()).toBe(4);
    // The schedule's and the token's sessions go with them.
    await getDb().schedule.delete({ where: { id: schedule.id } });
    await getDb().botToken.delete({ where: { id: bot.id } });
    expect(await getDb().authSession.count()).toBe(2);
  });

  it("one fire per schedule and planned time; missed stretches carry their end and count", async () => {
    const db = getDb();
    const at = new Date("2026-10-14T17:00:00Z");
    await db.scheduleFire.create({ data: { scheduleId: schedule.id, scheduledFor: at, status: "started", scheduleVersion: 1 } });
    await expect(db.scheduleFire.create({ data: { scheduleId: schedule.id, scheduledFor: at, status: "skipped_overlap", scheduleVersion: 1 } })).rejects.toThrow();
    await expect(db.scheduleFire.create({ data: { scheduleId: schedule.id, scheduledFor: new Date("2026-10-13T17:00:00Z"), status: "missed", scheduleVersion: 1 } })).rejects.toThrow();
    await db.scheduleFire.create({ data: { scheduleId: schedule.id, scheduledFor: new Date("2026-10-12T17:00:00Z"), status: "missed", missedUntil: new Date("2026-10-13T17:00:00Z"), missedCount: 2, scheduleVersion: 1 } });
  });

  it("a schedule targets listed scenarios or a tag, not both", async () => {
    const tag = await getDb().tag.create({ data: { workspaceId: ctx.workspace.id, name: "smoke" } });
    await expect(getDb().schedule.create({ data: { workspaceId: ctx.workspace.id, name: "Both", environmentId: env.id, scenarioIds: ["x"], tagId: tag.id, cron: "* * * * *", timezone: "UTC" } })).rejects.toThrow();
    const byTag = await getDb().schedule.create({ data: { workspaceId: ctx.workspace.id, name: "Tag", environmentId: env.id, tagId: tag.id, cron: "* * * * *", timezone: "UTC" } });
    // Deleting the tag leaves a schedule with no target (it fires as refused(no_scenarios)).
    await getDb().tag.delete({ where: { id: tag.id } });
    expect((await getDb().schedule.findUniqueOrThrow({ where: { id: byTag.id } })).tagId).toBeNull();
  });

  it("idempotency keys are unique per token; report windows per webhook and end", async () => {
    const db = getDb();
    await db.apiIdempotency.create({ data: { botTokenId: bot.id, key: "k1", requestHash: "a" } });
    await expect(db.apiIdempotency.create({ data: { botTokenId: bot.id, key: "k1", requestHash: "a" } })).rejects.toThrow();
    const other = await db.botToken.create({ data: { workspaceId: ctx.workspace.id, name: "CI 2", tokenHash: "h2", prefix: "d2e_efgh", scopes: [], expiresAt: new Date() } });
    await db.apiIdempotency.create({ data: { botTokenId: other.id, key: "k1", requestHash: "b" } });

    const hook = await db.slackWebhook.create({ data: { workspaceId: ctx.workspace.id, name: "ops", urlEncrypted: "x", urlHint: "abcd" } });
    const delivery = () => db.notificationDelivery.create({ data: { webhookId: hook.id, kind: "report", payload: {} } });
    const to = new Date("2026-10-14T00:00:00Z");
    await db.reportWindow.create({ data: { webhookId: hook.id, from: new Date("2026-10-13T00:00:00Z"), to, deliveryId: (await delivery()).id } });
    await expect(db.reportWindow.create({ data: { webhookId: hook.id, from: new Date("2026-10-13T00:00:00Z"), to, deliveryId: (await delivery()).id } })).rejects.toThrow();
  });
});
