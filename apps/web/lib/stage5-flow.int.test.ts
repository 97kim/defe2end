// Stage 5 contract section 3 and 11.1 (lead part B): creation inside a caller's transaction with origin and
// value subject, subject-based values and sessions, finish notifications from every ending path, unattended
// value lifetime, and capture targets.
import { claimNextRun, completeDesktopRun, connectDevice, enqueueFinishNotifications, failDesktopRun, finishRun, reapExpiredRuns, requestCancel, resolveRunVariables, settleGroup, startDesktopRun, stopAllRuns } from "@defe2end/db";
import { beforeEach, expect, it } from "vitest";
import * as captureRoute from "../app/api/w/[slug]/environments/[environmentId]/auth-session/capture/route";
import * as variableRoute from "../app/api/w/[slug]/variables/[variableId]/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { saveAuthSession } from "./auth-sessions";
import { getDb } from "./db";
import { createRunsInTx, resolveScenarioRuns } from "./run-create";

const CLAIM = { workerId: "w", runnerVersion: "1", leaseMs: 30_000, maxConcurrentRuns: 100, workspaceConcurrency: 100 };
const state = { cookies: [{ name: "sid", value: "v", domain: "shop.example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const }], origins: [] };

describeDb("stage 5 flow", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let env: { id: string };
  let scenarios: { id: string }[];
  let schedule: { id: string };
  let variable: { id: string };

  beforeEach(async () => {
    await resetDatabase();
    process.env.MIN_FREE_DISK_MB = "0";
    ctx = await workspaceWithRoles();
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    env = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://shop.example.com" } });
    scenarios = [];
    for (const name of ["a", "b"]) scenarios.push(await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name, steps: [{ id: "s1", action: "goto", url: "/{{TOKEN}}" }] } }));
    variable = await db.variable.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, key: "TOKEN", scope: "personal" } });
    schedule = await db.schedule.create({ data: { workspaceId: ctx.workspace.id, name: "Nightly", environmentId: env.id, scenarioIds: scenarios.map((s) => s.id), cron: "0 2 * * *", timezone: "UTC" } });
  });

  const createForSchedule = (overrides: Record<string, unknown> = {}) =>
    getDb().$transaction(async (tx) =>
      createRunsInTx(tx, {
        workspaceId: ctx.workspace.id,
        subject: { kind: "schedule", scheduleId: schedule.id },
        trigger: "schedule",
        requestHash: "h",
        options: {},
        placement: { location: "server" },
        group: { environmentId: env.id, mode: "sequential", continueOnFailure: true },
        resolve: (t) => resolveScenarioRuns(t, ctx.workspace.id, env.id, scenarios.map((s) => s.id)),
        ...overrides,
      }),
    );

  it("unattended creation uses the schedule's own values only, records the origin, and is server-only", async () => {
    const db = getDb();
    // A person's value doesn't stand in for the schedule's.
    await db.personalVariableValue.create({ data: { variableId: variable.id, userId: ctx.users.EDITOR.id, value: "person" } });
    await expect(createForSchedule()).rejects.toMatchObject({ code: "variable_missing" });
    await db.scheduleVariableValue.create({ data: { scheduleId: schedule.id, variableId: variable.id, value: "sched" } });
    await expect(createForSchedule({ placement: { location: "desktop" } })).rejects.toMatchObject({ code: "invalid_request" });
    const created = await createForSchedule();
    const runs = await db.run.findMany({ where: { groupRunId: created.groupRunId! } });
    expect(runs.every((r) => r.requestedById === null && r.scheduleId === schedule.id && r.trigger === "schedule")).toBe(true);
    expect(await db.groupRun.findUniqueOrThrow({ where: { id: created.groupRunId! } })).toMatchObject({ scheduleId: schedule.id, requestedById: null });
    const resolved = await resolveRunVariables(db, { workspaceId: ctx.workspace.id, environmentId: env.id, subject: { kind: "schedule", scheduleId: schedule.id }, steps: [{ url: "/{{TOKEN}}" }] }, (c) => c);
    expect(resolved).toEqual({ ok: true, variables: { TOKEN: { value: "sched", secret: false } } });

    // Sessions: the environment needs one; the person's session doesn't count for the schedule.
    await db.environment.update({ where: { id: env.id }, data: { useAuthSession: true } });
    const session = (owner: Record<string, string>) => db.authSession.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, ...owner, encryptedState: "x", cookieCount: 1, sizeBytes: 1, savedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } });
    await session({ userId: ctx.users.EDITOR.id });
    await expect(createForSchedule()).rejects.toMatchObject({ code: "auth_session_missing" });
    await session({ scheduleId: schedule.id });
    await createForSchedule();
  });

  it("finish notifications come from every ending path, one per group, none for people's cancels", async () => {
    const db = getDb();
    await db.scheduleVariableValue.create({ data: { scheduleId: schedule.id, variableId: variable.id, value: "sched" } });
    const hook = await db.slackWebhook.create({ data: { workspaceId: ctx.workspace.id, name: "ops", urlEncrypted: "x", urlHint: "abcd", notifyOn: "all", sources: ["schedule", "api", "manual"] } });
    const deliveries = () => db.notificationDelivery.findMany({ where: { webhookId: hook.id }, orderBy: { createdAt: "asc" } });

    // Group: children never send; settleGroup sends one for the group.
    const g = await createForSchedule();
    const claimed = await claimNextRun(db, CLAIM);
    await finishRun(db, claimed!.id, claimed!.claimToken, { status: "failed" });
    const second = await claimNextRun(db, CLAIM);
    await finishRun(db, second!.id, second!.claimToken, { status: "passed" });
    let rows = await deliveries();
    expect(rows.map((r) => [r.kind, r.groupRunId])).toEqual([["group", g.groupRunId]]);
    expect(rows[0]!.payload).toMatchObject({ kind: "group", status: "failed", origin: { kind: "schedule", name: "Nightly" } });

    // Single runs: worker verdict, lease expiry (reaper), desktop failure and reconcile; a person's cancel sends nothing.
    const single = async (data: Record<string, unknown> = {}) =>
      db.run.create({ data: { workspaceId: ctx.workspace.id, scenarioId: scenarios[0]!.id, environmentId: env.id, trigger: "schedule", scheduleId: schedule.id, snapshot: { scenario: { name: "a" }, environment: { name: "Staging" } }, ...data } });
    const r1 = await single();
    const c1 = await claimNextRun(db, CLAIM);
    expect(c1!.id).toBe(r1.id);
    await finishRun(db, r1.id, c1!.claimToken, { status: "passed" });
    const r2 = await single();
    await claimNextRun(db, CLAIM);
    await db.run.update({ where: { id: r2.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    await reapExpiredRuns(db);
    const r3 = await single({ location: "desktop" });
    await failDesktopRun(db, r3.id, ["queued"], "permission_lost", "x");
    const manual = await db.run.create({ data: { workspaceId: ctx.workspace.id, scenarioId: scenarios[0]!.id, environmentId: env.id, trigger: "manual", requestedById: ctx.users.EDITOR.id, snapshot: {} } });
    await requestCancel(db, ctx.workspace.id, manual.id, ctx.users.EDITOR.id);
    rows = await deliveries();
    expect(rows.filter((r) => r.kind === "run").map((r) => r.runId)).toEqual([r1.id, r2.id, r3.id]);

    // A stop-all records the person who asked (no message); without one (no person) the cancel notifies.
    const r5 = await single();
    await stopAllRuns(db, ctx.workspace.id, ctx.users.ADMIN.id);
    expect((await deliveries()).some((r) => r.runId === r5.id)).toBe(false);
    const r4 = await single();
    await stopAllRuns(db, ctx.workspace.id);
    expect((await deliveries()).some((r) => r.runId === r4.id)).toBe(true);

    // Desktop completion and reconcile (person's PC runs, manual source).
    const device = await db.desktopDevice.create({ data: { installId: "i", userId: ctx.users.EDITOR.id, label: "pc" } });
    const { connectionId } = await connectDevice(db, device.id, { appVersion: "1.0.0", runnerVersion: "1", capabilities: [] }, []);
    const pc = await db.run.create({ data: { workspaceId: ctx.workspace.id, scenarioId: scenarios[0]!.id, environmentId: env.id, trigger: "manual", requestedById: ctx.users.EDITOR.id, location: "desktop", desktopDeviceId: device.id, dispatchedAt: new Date(), dispatchedConnectionId: connectionId, snapshot: {} } });
    const started = await startDesktopRun(db, pc.id, device.id, 90_000);
    await completeDesktopRun(db, pc.id, (started as { claimToken: string }).claimToken, [], { status: "passed", warningCount: 0, attemptCount: 1, passedAfterRetry: false });
    const lost = await db.run.create({ data: { workspaceId: ctx.workspace.id, scenarioId: scenarios[0]!.id, environmentId: env.id, trigger: "manual", requestedById: ctx.users.EDITOR.id, location: "desktop", desktopDeviceId: device.id, dispatchedAt: new Date(Date.now() - 60_000), dispatchedConnectionId: "old", snapshot: {} } });
    await connectDevice(db, device.id, { appVersion: "1.0.0", runnerVersion: "1", capabilities: [] }, []);
    const ids = (await deliveries()).map((r) => r.runId);
    expect(ids).toContain(pc.id);
    expect(ids).toContain(lost.id);
    // Test runs never notify; calling again for an already-decided run is up to the caller (no dedupe here).
    expect(await enqueueFinishNotifications(db, { groupRunIds: ["missing"] })).toBe(0);
    await settleGroup(db, g.groupRunId!);
    expect((await deliveries()).filter((r) => r.kind === "group")).toHaveLength(1);
  });

  it("failures-only and source filters; scope or secret changes drop schedules' and bots' own values", async () => {
    const db = getDb();
    const hook = await db.slackWebhook.create({ data: { workspaceId: ctx.workspace.id, name: "ci", urlEncrypted: "x", urlHint: "abcd", notifyOn: "failures", sources: ["api"] } });
    const bot = await db.botToken.create({ data: { workspaceId: ctx.workspace.id, name: "CI", tokenHash: "h", prefix: "d2e_abcd", scopes: [], expiresAt: new Date(Date.now() + 86_400_000) } });
    const ended = async (status: "passed" | "failed", origin: Record<string, unknown>) => {
      const run = await db.run.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, trigger: "api", status, finishedAt: new Date(), snapshot: {}, ...origin } });
      await enqueueFinishNotifications(db, { runIds: [run.id] });
      return run.id;
    };
    await ended("passed", { botTokenId: bot.id });
    const failed = await ended("failed", { botTokenId: bot.id });
    await ended("failed", { trigger: "schedule", scheduleId: schedule.id });
    expect((await db.notificationDelivery.findMany({ where: { webhookId: hook.id } })).map((d) => d.runId)).toEqual([failed]);

    await db.scheduleVariableValue.create({ data: { scheduleId: schedule.id, variableId: variable.id, value: "s" } });
    await db.botVariableValue.create({ data: { botTokenId: bot.id, variableId: variable.id, value: "b" } });
    await callRoute(variableRoute.PATCH, { method: "PATCH", params: { slug: ctx.workspace.slug, variableId: variable.id }, headers: await sessionHeaders(ctx.users.ADMIN.id), body: { isSecret: true } });
    expect(await db.scheduleVariableValue.count()).toBe(0);
    expect(await db.botVariableValue.count()).toBe(0);
  });

  it("capture targets: schedule or bot needs the app feature and the target's right; sessions saved under the target", async () => {
    const db = getDb();
    const bot = await db.botToken.create({ data: { workspaceId: ctx.workspace.id, name: "CI", tokenHash: "h", prefix: "d2e_abcd", scopes: [], expiresAt: new Date(Date.now() + 86_400_000) } });
    const editor = await sessionHeaders(ctx.users.EDITOR.id);
    const device = await db.desktopDevice.create({ data: { installId: "i", userId: ctx.users.EDITOR.id, label: "pc", connectionId: "c", lastSeenAt: new Date(), capabilities: ["auth-session"] } });
    const capture = (target: unknown, headers = editor) => callRoute(captureRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug, environmentId: env.id }, headers, body: { target } });
    const old = await capture({ kind: "schedule", scheduleId: schedule.id });
    expect(old.status).toBe(409);
    expect((await old.json()).error).toMatchObject({ code: "app_update_required", missing: ["auth-session-target"] });
    await db.desktopDevice.update({ where: { id: device.id }, data: { capabilities: ["auth-session", "auth-session-target"] } });
    expect((await capture({ kind: "schedule", scheduleId: schedule.id })).status).toBe(202);
    const queued = await db.desktopCaptureRequest.findUniqueOrThrow({ where: { deviceId: device.id } });
    expect(queued.message).toMatchObject({ target: { kind: "schedule", scheduleId: schedule.id } });
    expect((await capture({ kind: "bot", botTokenId: bot.id })).status).toBe(403); // botToken.write is ADMIN
    expect((await capture({ kind: "schedule", scheduleId: "other" })).status).toBe(404);

    await saveAuthSession(ctx.users.EDITOR.id, { workspaceId: ctx.workspace.id, environmentId: env.id, target: { kind: "schedule", scheduleId: schedule.id }, storageState: state });
    expect(await db.authSession.findFirst({ where: { scheduleId: schedule.id } })).toMatchObject({ userId: null, botTokenId: null });
    await expect(saveAuthSession(ctx.users.EDITOR.id, { workspaceId: ctx.workspace.id, environmentId: env.id, target: { kind: "bot", botTokenId: bot.id }, storageState: state })).rejects.toMatchObject({ code: "forbidden" });
    await saveAuthSession(ctx.users.ADMIN.id, { workspaceId: ctx.workspace.id, environmentId: env.id, target: { kind: "bot", botTokenId: bot.id }, storageState: state });
    expect(await db.authSession.count()).toBe(2);
  });
});
