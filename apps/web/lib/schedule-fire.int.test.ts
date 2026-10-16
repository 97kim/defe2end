// Stage 5 contract sections 4 and 10 (scheduler): single fire under concurrency, edits and turning off during
// a fire, missed stretches, overlap, the schedule's own values only, empty tags, daylight saving, and the fire
// and its runs in one transaction.
import { fireDueSchedules, fireSchedule, lockWorkspaceRuns } from "@defe2end/db";
import { cronTimesBetween } from "@defe2end/shared";
import { beforeEach, expect, it } from "vitest";
import { describeDb, resetDatabase } from "../test/db";
import { workspaceWithRoles } from "../test/helpers";
import { getDb } from "./db";
import { scheduleFireDeps } from "./schedule-fire";
import { setScheduleValue } from "./schedules";

const ago = (ms: number) => new Date(Date.now() - ms);

describeDb("schedule fires", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let env: { id: string; siteId: string };
  let scenarios: { id: string }[];
  let schedule: { id: string };

  beforeEach(async () => {
    await resetDatabase();
    process.env.MIN_FREE_DISK_MB = "0";
    ctx = await workspaceWithRoles();
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    env = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://shop.example.com" } });
    scenarios = [];
    for (const name of ["a", "b"]) scenarios.push(await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name, steps: [{ id: "s1", action: "goto", url: "/" }] } }));
    schedule = await db.schedule.create({
      data: { workspaceId: ctx.workspace.id, name: "Yearly", environmentId: env.id, scenarioIds: scenarios.map((s) => s.id), cron: "0 3 1 1 *", timezone: "UTC", nextRunAt: ago(1_000) },
    });
  });

  // Most tests use a yearly expression, so no other planned time passes between `nextRunAt` and now.
  const everyMinute = () => getDb().schedule.update({ where: { id: schedule.id }, data: { cron: "* * * * *" } });
  const fires = () => getDb().scheduleFire.findMany({ where: { scheduleId: schedule.id }, orderBy: { scheduledFor: "asc" } });
  const groups = () => getDb().groupRun.findMany({ where: { scheduleId: schedule.id } });

  it("two leaders at once make one fire and one group, and move nextRunAt past now", async () => {
    const db = getDb();
    const before = (await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).nextRunAt!;
    await Promise.all([fireSchedule(db, schedule.id, scheduleFireDeps), fireSchedule(db, schedule.id, scheduleFireDeps), fireDueSchedules(db, scheduleFireDeps)]);
    const rows = await fires();
    expect(rows.map((r) => [r.status, r.scheduledFor.getTime()])).toEqual([["started", before.getTime()]]);
    const [group] = await groups();
    expect(rows[0]!.groupRunId).toBe(group!.id);
    expect(await db.run.count({ where: { groupRunId: group!.id, trigger: "schedule", requestedById: null } })).toBe(2);
    expect((await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).nextRunAt!.getTime()).toBeGreaterThan(Date.now() - 1_000);
  });

  it("an edit or turning off that holds the row first wins: no fire with the old settings", async () => {
    const db = getDb();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const edit = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Schedule" WHERE id = ${schedule.id} FOR UPDATE`;
      locked();
      await held;
      await tx.schedule.update({ where: { id: schedule.id }, data: { cron: "0 3 * * *", nextRunAt: new Date(Date.now() + 3_600_000), version: { increment: 1 } } });
    });
    await isLocked;
    const fire = fireSchedule(db, schedule.id, scheduleFireDeps);
    await new Promise((r) => setTimeout(r, 200));
    release();
    await edit;
    expect(await fire).toBeNull();

    await db.schedule.update({ where: { id: schedule.id }, data: { nextRunAt: ago(1_000), enabled: true } });
    let pending!: ReturnType<typeof fireSchedule>;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Schedule" WHERE id = ${schedule.id} FOR UPDATE`;
      pending = fireSchedule(db, schedule.id, scheduleFireDeps);
      await new Promise((r) => setTimeout(r, 200));
      await tx.schedule.update({ where: { id: schedule.id }, data: { enabled: false, nextRunAt: null } });
    });
    expect(await pending).toBeNull();
    expect(await fires()).toEqual([]);
    expect(await groups()).toEqual([]);
  });

  it("records a worker outage as one missed stretch with every planned time, and runs nothing", async () => {
    const db = getDb();
    const planned = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000);
    const hook = await db.slackWebhook.create({ data: { workspaceId: ctx.workspace.id, name: "ops", urlEncrypted: "x", urlHint: "abcd", notifyOn: "failures", sources: ["schedule"] } });
    await db.slackWebhook.create({ data: { workspaceId: ctx.workspace.id, name: "manual only", urlEncrypted: "x", urlHint: "abcd", notifyOn: "all", sources: ["manual"] } });
    await everyMinute();
    await db.schedule.update({ where: { id: schedule.id }, data: { nextRunAt: planned } });
    await fireSchedule(db, schedule.id, scheduleFireDeps);
    const [row, ...rest] = await fires();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ status: "missed", scheduledFor: planned });
    expect(row!.missedCount).toBeGreaterThanOrEqual(10);
    expect(row!.missedUntil!.getTime()).toBe(planned.getTime() + (row!.missedCount! - 1) * 60_000);
    expect(await groups()).toEqual([]);
    const deliveries = await db.notificationDelivery.findMany();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ webhookId: hook.id, kind: "scheduleFire", scheduleFireId: row!.id, payload: { kind: "scheduleFire", status: "missed", missedCount: row!.missedCount } });
  });

  it("within the grace runs the earliest planned time and records the other passed ones as missed", async () => {
    const db = getDb();
    // Not on the cron grid and 100 s late: at least one whole minute passed in between.
    const planned = ago(100_000);
    await everyMinute();
    await db.schedule.update({ where: { id: schedule.id }, data: { nextRunAt: planned } });
    await fireSchedule(db, schedule.id, scheduleFireDeps);
    const rows = await fires();
    expect(rows.map((r) => r.status)).toEqual(["started", "missed"]);
    expect(rows[0]!.scheduledFor).toEqual(planned);
    expect(rows[1]!.scheduledFor.getTime() % 60_000).toBe(0);
    expect(rows[1]!.missedCount).toBeGreaterThanOrEqual(1);
  });

  it("skips while a run of the schedule is waiting (another planned time), or runs again when overlap is allowed", async () => {
    const db = getDb();
    await fireSchedule(db, schedule.id, scheduleFireDeps);
    await db.schedule.update({ where: { id: schedule.id }, data: { nextRunAt: ago(500) } });
    await fireSchedule(db, schedule.id, scheduleFireDeps);
    expect((await fires()).map((r) => r.status)).toEqual(["started", "skipped_overlap"]);
    await db.schedule.update({ where: { id: schedule.id }, data: { overlap: "allow", nextRunAt: ago(100) } });
    await fireSchedule(db, schedule.id, scheduleFireDeps);
    expect((await fires()).map((r) => r.status)).toEqual(["started", "skipped_overlap", "started"]);
    expect(await groups()).toHaveLength(2);
  });

  it("uses the schedule's own values only: a person's value doesn't count, and the refusal leaves no runs", async () => {
    const db = getDb();
    await db.scenario.update({ where: { id: scenarios[1]!.id }, data: { steps: [{ id: "s1", action: "goto", url: "/{{TOKEN}}" }] } });
    const variable = await db.variable.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, key: "TOKEN", scope: "personal" } });
    await db.personalVariableValue.create({ data: { variableId: variable.id, userId: ctx.users.EDITOR.id, value: "person" } });
    const hook = await db.slackWebhook.create({ data: { workspaceId: ctx.workspace.id, name: "ops", urlEncrypted: "x", urlHint: "abcd", notifyOn: "failures", sources: ["schedule"] } });
    await fireSchedule(db, schedule.id, scheduleFireDeps);
    const [row] = await fires();
    expect(row).toMatchObject({ status: "refused", reasonCode: "variable_missing", groupRunId: null });
    expect(await groups()).toEqual([]);
    expect(await db.run.count()).toBe(0);
    expect(await db.notificationDelivery.findMany({ where: { webhookId: hook.id } })).toMatchObject([{ kind: "scheduleFire", payload: { status: "refused", reasonCode: "variable_missing" } }]);

    await db.scheduleVariableValue.create({ data: { scheduleId: schedule.id, variableId: variable.id, value: "sched" } });
    await db.schedule.update({ where: { id: schedule.id }, data: { nextRunAt: ago(100) } });
    await fireSchedule(db, schedule.id, scheduleFireDeps);
    expect((await fires()).map((r) => r.status)).toEqual(["refused", "started"]);
  });

  it("a tag with no scenarios of the site is refused(no_scenarios); a tagged one runs", async () => {
    const db = getDb();
    const tag = await db.tag.create({ data: { workspaceId: ctx.workspace.id, name: "smoke" } });
    await db.schedule.update({ where: { id: schedule.id }, data: { scenarioIds: [], tagId: tag.id } });
    await fireSchedule(db, schedule.id, scheduleFireDeps);
    expect(await fires()).toMatchObject([{ status: "refused", reasonCode: "no_scenarios" }]);
    await db.scenarioTag.create({ data: { workspaceId: ctx.workspace.id, scenarioId: scenarios[0]!.id, tagId: tag.id } });
    await db.schedule.update({ where: { id: schedule.id }, data: { nextRunAt: ago(100) } });
    await fireSchedule(db, schedule.id, scheduleFireDeps);
    const [, started] = await fires();
    expect(await db.run.findMany({ where: { groupRunId: started!.groupRunId! }, select: { scenarioId: true } })).toEqual([{ scenarioId: scenarios[0]!.id }]);
  });

  it("plans across daylight saving with the shared cron functions (a missing wall-clock time is skipped)", async () => {
    const { nextCronTime } = await import("@defe2end/shared");
    // America/New_York springs forward on 2026-03-08: 02:30 doesn't exist that day.
    const next = nextCronTime("30 2 * * *", "America/New_York", new Date("2026-03-07T08:00:00Z"));
    expect(next!.toISOString()).toBe("2026-03-09T06:30:00.000Z");
    expect(scheduleFireDeps.cron.next("30 2 * * *", "America/New_York", new Date("2026-03-07T08:00:00Z"))).toEqual(next);
  });
  it("deleting the environment while a fire waits doesn't deadlock: both take the workspace lock before the schedule row", async () => {
    const db = getDb();
    let fire!: ReturnType<typeof fireSchedule>;
    await db.$transaction(async (tx) => {
      // Like environment deletion: workspace run lock, then the delete that cascades to the schedule row.
      await lockWorkspaceRuns(tx, ctx.workspace.id);
      fire = fireSchedule(db, schedule.id, scheduleFireDeps);
      await new Promise((r) => setTimeout(r, 300));
      await tx.environment.delete({ where: { id: env.id } });
    });
    expect(await fire).toBeNull();
    expect(await db.schedule.count()).toBe(0);
    expect(await db.run.count()).toBe(0);
  });

  it("records a missed stretch longer than one round's cap over several rounds, without a gap", async () => {
    const db = getDb();
    await everyMinute();
    const planned = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 20 * 60_000);
    await db.schedule.update({ where: { id: schedule.id }, data: { nextRunAt: planned } });
    const capped = { ...scheduleFireDeps, cron: { ...scheduleFireDeps.cron, between: (e: string, tz: string, a: Date, u: Date) => cronTimesBetween(e, tz, a, u, 5) } };
    for (let round = 0; round < 10; round++) if (!(await fireSchedule(db, schedule.id, capped))) break;
    const rows = await fires();
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((r) => r.status === "missed")).toBe(true);
    expect(rows[0]!.scheduledFor).toEqual(planned);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.scheduledFor.getTime()).toBe(rows[i - 1]!.missedUntil!.getTime() + 60_000);
    const total = rows.reduce((n, r) => n + r.missedCount!, 0);
    expect(total).toBe((rows.at(-1)!.missedUntil!.getTime() - planned.getTime()) / 60_000 + 1);
    expect(total).toBeGreaterThanOrEqual(20);
    expect((await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).nextRunAt!.getTime()).toBeGreaterThan(Date.now() - 1_000);
  });

  it("a schedule value saved while the variable turns secret is never left in plaintext", async () => {
    const db = getDb();
    const variable = await db.variable.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, key: "TOKEN", scope: "personal" } });
    let saving!: Promise<void>;
    await db.$transaction(async (tx) => {
      // Like the variable PATCH: flip the flag (row lock), drop the unattended values, commit a moment later.
      await tx.variable.update({ where: { id: variable.id }, data: { isSecret: true } });
      await tx.scheduleVariableValue.deleteMany({ where: { variableId: variable.id } });
      saving = setScheduleValue(ctx.workspace.id, ctx.users.EDITOR.id, schedule.id, variable.id, "plain-then-secret");
      await new Promise((r) => setTimeout(r, 300));
    });
    await saving;
    const row = await db.scheduleVariableValue.findUniqueOrThrow({ where: { scheduleId_variableId: { scheduleId: schedule.id, variableId: variable.id } } });
    expect(row.value).toBeNull();
    expect(row.valueEncrypted).not.toBeNull();
  });
});
