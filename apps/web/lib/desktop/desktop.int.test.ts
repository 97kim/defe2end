// Stage 4 contract section 11, server side: tokens, the stream (426/401, connection generation, permission
// re-check, dispatch, reconcile), run creation on a device, start/heartbeat/complete ownership and the reaper.
import { claimNextRun, reapExpiredRuns } from "@defe2end/db";
import { DESKTOP_CAPABILITIES, formatDesktopClientHeader } from "@defe2end/shared";
import { beforeEach, expect, it } from "vitest";
import * as completeRoute from "../../app/api/desktop/runs/[id]/complete/route";
import * as heartbeatRoute from "../../app/api/desktop/runs/[id]/heartbeat/route";
import * as startRoute from "../../app/api/desktop/runs/[id]/start/route";
import * as tokenRoute from "../../app/api/desktop/token/route";
import * as groupsRoute from "../../app/api/w/[slug]/groups/route";
import * as runsRoute from "../../app/api/w/[slug]/runs/route";
import { describeDb, resetDatabase } from "../../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../../test/helpers";
import { getDb } from "../db";
import { openDesktopStream, type DesktopStreamSession } from "./stream";

const ORIGIN = new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000").origin;
const INSTALL = "8b0f5f7e-2a4c-4c1e-9d55-0a4c5c7a1b11";

describeDb("desktop server", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let editor: Headers;
  let environment: { id: string };
  let scenarios: { id: string }[];

  beforeEach(async () => {
    await resetDatabase();
    process.env.MIN_FREE_DISK_MB = "0";
    ctx = await workspaceWithRoles();
    editor = await sessionHeaders(ctx.users.EDITOR.id);
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    environment = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://example.com" } });
    scenarios = [];
    for (const name of ["a", "b"]) scenarios.push(await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name, steps: [{ id: "s1", action: "goto", url: `/${name}` }] } }));
  });

  const exchange = async (headers: Headers, origin = ORIGIN, installId = INSTALL) => {
    const h = new Headers(headers);
    h.set("origin", origin);
    return callRoute(tokenRoute.POST, { method: "POST", headers: h, body: { installId, label: "ab12" } });
  };
  const tokenFor = async (headers = editor) => (await (await exchange(headers)).json()) as { token: string; deviceId: string; userId: string };
  const streamRequest = (token: string, opts: { app?: string; protocol?: number; active?: string[]; capabilities?: readonly string[] } = {}) =>
    new Request("http://localhost:3000/api/desktop/stream", {
      headers: {
        authorization: `Bearer ${token}`,
        "defe2end-client": formatDesktopClientHeader({ app: opts.app ?? "1.0.0", runner: "1.0.0", protocol: opts.protocol ?? 1 }),
        "defe2end-capabilities": (opts.capabilities ?? DESKTOP_CAPABILITIES).join(","),
        "defe2end-active-runs": (opts.active ?? []).join(","),
      },
    });
  const connect = async (token: string, opts: Parameters<typeof streamRequest>[1] = {}): Promise<DesktopStreamSession> => {
    const opened = await openDesktopStream(streamRequest(token, opts));
    if (!opened.ok) throw new Error(`stream refused ${opened.response.status}`);
    return opened.session;
  };
  const createDesktopRun = (body: Record<string, unknown> = {}) =>
    callRoute(runsRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug }, headers: editor, body: { scenarioId: scenarios[0]!.id, environmentId: environment.id, location: "desktop", ...body } });
  const app = (token: string) => new Headers({ authorization: `Bearer ${token}` });
  const start = (token: string, id: string) => callRoute(startRoute.POST, { method: "POST", params: { id }, headers: app(token) });

  it("token exchange checks Origin, binds a device per install × user, and is revoked on disable", async () => {
    expect((await exchange(editor, "https://evil.example")).status).toBe(403);
    const a = await tokenFor();
    const admin = await tokenFor(await sessionHeaders(ctx.users.ADMIN.id));
    expect(admin.deviceId).not.toBe(a.deviceId);
    expect((await tokenFor()).deviceId).toBe(a.deviceId);
    const session = await connect(a.token);
    await getDb().desktopToken.updateMany({ where: { userId: ctx.users.EDITOR.id }, data: { revokedAt: new Date() } });
    expect(await session.tick()).toEqual([]);
    expect(session.closed).toBe(true);
    expect((await openDesktopStream(streamRequest(a.token))).ok).toBe(false);
  });

  it("refuses old apps and other protocols with 426, bad tokens with 401", async () => {
    const { token } = await tokenFor();
    process.env.DESKTOP_MIN_VERSION = "2.0.0";
    try {
      const old = await openDesktopStream(streamRequest(token, { app: "2.0.0-beta.1" }));
      expect(old.ok || old.response.status).toBe(426);
      if (!old.ok) expect(await old.response.json()).toMatchObject({ code: "app_update_required", minimum: "2.0.0" });
      expect((await openDesktopStream(streamRequest(token, { app: "2.0.0" }))).ok).toBe(true);
      const proto = await openDesktopStream(streamRequest(token, { app: "2.0.0", protocol: 2 }));
      expect(proto.ok || proto.response.status).toBe(426);
    } finally {
      delete process.env.DESKTOP_MIN_VERSION;
    }
    const bad = await openDesktopStream(streamRequest("nope"));
    expect(bad.ok || bad.response.status).toBe(401);
  });

  it("run creation needs an online device with the capabilities; the worker never claims desktop runs", async () => {
    const res = await createDesktopRun();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("desktop_not_connected");
    const { token } = await tokenFor();
    await connect(token, { capabilities: ["stop-run"] });
    const missing = await createDesktopRun();
    expect(missing.status).toBe(409);
    expect((await missing.json()).error).toMatchObject({ code: "app_update_required", missing: ["masking-v1", "goto"] });
    await connect(token);
    expect((await createDesktopRun()).status).toBe(201);
    expect(await claimNextRun(getDb(), { workerId: "w", runnerVersion: "1", leaseMs: 30_000, maxConcurrentRuns: 4, workspaceConcurrency: 4 })).toBeNull();
  });

  it("dispatches on the current connection only, and errors runs whose requester lost run.create", async () => {
    const { token } = await tokenFor();
    const old = await connect(token);
    const current = await connect(token);
    const run = (await (await createDesktopRun()).json()) as { id: string };
    expect(await old.tick()).toEqual([]);
    expect(old.closed).toBe(true);
    const sent = await current.tick();
    expect(sent.map((m) => m.type)).toEqual(["run"]);
    expect(await current.tick()).toEqual([]); // not sent twice

    const second = (await (await createDesktopRun()).json()) as { id: string };
    await getDb().membership.update({ where: { userId_workspaceId: { userId: ctx.users.EDITOR.id, workspaceId: ctx.workspace.id } }, data: { role: "VIEWER" } });
    expect(await current.tick()).toEqual([]);
    expect(await getDb().run.findUnique({ where: { id: second.id }, select: { status: true, errorCode: true } })).toEqual({ status: "error", errorCode: "permission_lost" });
    expect((await getDb().run.findUnique({ where: { id: run.id } }))!.status).toBe("queued");
  });

  it("sends no runs while automation is paused after a restore, and sends them once resumed", async () => {
    const { token } = await tokenFor();
    const session = await connect(token);
    await createDesktopRun();
    await getDb().instanceSetting.upsert({ where: { id: 1 }, create: { id: 1, automationPausedAt: new Date() }, update: { automationPausedAt: new Date() } });
    expect(await session.tick()).toEqual([]);
    await getDb().instanceSetting.update({ where: { id: 1 }, data: { automationPausedAt: null } });
    expect((await session.tick()).map((m) => m.type)).toEqual(["run"]);
  });

  it("start is conditional and repeatable; complete re-judges, then answers run_finalized", async () => {
    const { token } = await tokenFor();
    const session = await connect(token);
    const run = (await (await createDesktopRun()).json()) as { id: string };
    expect((await start(token, run.id)).status).toBe(404); // not sent yet
    await session.tick();
    const first = await (await start(token, run.id)).json();
    expect(first).toMatchObject({ status: "running", claimToken: expect.any(String) });
    expect(await (await start(token, run.id)).json()).toMatchObject({ claimToken: first.claimToken });
    const other = await tokenFor(await sessionHeaders(ctx.users.ADMIN.id));
    expect((await start(other.token, run.id)).status).toBe(404);

    const hb = await callRoute(heartbeatRoute.POST, { method: "POST", params: { id: run.id }, headers: app(token), body: { claimToken: first.claimToken } });
    expect(await hb.json()).toMatchObject({ leaseExpiresAt: expect.any(String), cancelRequested: false });

    const step = { index: 0, stepId: "s1", action: "goto", status: "failed", attempt: 1, attempts: 1, startedAt: new Date().toISOString(), durationMs: 5 };
    const body = { claimToken: first.claimToken, verdict: "passed", stopCause: { type: "none" }, attemptCount: 1, passedAfterRetry: false, durationMs: 5, steps: [step] };
    const done = await callRoute(completeRoute.POST, { method: "POST", params: { id: run.id }, headers: app(token), body });
    expect(await done.json()).toEqual({ status: "error" });
    const stored = await getDb().run.findUnique({ where: { id: run.id }, include: { stepResults: true } });
    expect(stored).toMatchObject({ status: "error", errorCode: "verdict_mismatch" });
    expect(stored!.stepResults).toHaveLength(1);
    const again = await callRoute(completeRoute.POST, { method: "POST", params: { id: run.id }, headers: app(token), body });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ code: "run_finalized", status: "error" });
  });

  it("a sequential group dispatches its next child only after the previous passed", async () => {
    const { token } = await tokenFor();
    const session = await connect(token);
    const res = await callRoute(groupsRoute.POST, {
      method: "POST",
      params: { slug: ctx.workspace.slug },
      headers: editor,
      body: { environmentId: environment.id, scenarioIds: scenarios.map((s) => s.id), mode: "sequential", continueOnFailure: false, location: "desktop" },
    });
    expect(res.status).toBe(201);
    const sent = await session.tick();
    expect(sent).toHaveLength(1);
    expect(await session.tick()).toEqual([]);
  });

  it("reconnect reconciliation ends sent runs the app forgot; unsent and listed ones stay", async () => {
    const { token } = await tokenFor();
    const s1 = await connect(token);
    const kept = (await (await createDesktopRun()).json()) as { id: string };
    const forgotten = (await (await createDesktopRun({ scenarioId: scenarios[1]!.id })).json()) as { id: string };
    await s1.tick();
    const claim = await (await start(token, forgotten.id)).json();
    expect(claim.status).toBe("running");
    const unsent = (await (await createDesktopRun()).json()) as { id: string };
    await new Promise((r) => setTimeout(r, 5));
    await connect(token, { active: [kept.id] });
    const status = async (id: string) => getDb().run.findUnique({ where: { id }, select: { status: true, errorCode: true } });
    expect(await status(kept.id)).toEqual({ status: "queued", errorCode: null });
    expect(await status(forgotten.id)).toEqual({ status: "error", errorCode: "desktop_lost" });
    expect(await status(unsent.id)).toEqual({ status: "queued", errorCode: null });
  });

  it("the reaper ends an expired desktop lease as desktop_lost; a late completion is refused", async () => {
    const { token } = await tokenFor();
    const session = await connect(token);
    const run = (await (await createDesktopRun()).json()) as { id: string };
    await session.tick();
    const { claimToken } = await (await start(token, run.id)).json();
    await getDb().run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    expect(await reapExpiredRuns(getDb())).toEqual([run.id]);
    expect((await getDb().run.findUnique({ where: { id: run.id } }))!.errorCode).toBe("desktop_lost");
    const late = await callRoute(completeRoute.POST, {
      method: "POST",
      params: { id: run.id },
      headers: app(token),
      body: { claimToken, verdict: "passed", stopCause: { type: "none" }, attemptCount: 1, passedAfterRetry: false, durationMs: 1, steps: [] },
    });
    expect(await late.json()).toEqual({ code: "run_finalized", status: "error" });
  });
});
