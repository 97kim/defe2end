// Stage 4 contract section 11, the rest of the server side: artifacts and attachments, stop-run, heartbeat,
// group start re-check, reconcile vs completion, other-workspace ids, and login sessions (section 5).
import { registerDesktopArtifact } from "@defe2end/db";
import { DESKTOP_CAPABILITIES, DESKTOP_HEADERS, formatDesktopClientHeader, type StorageState } from "@defe2end/shared";
import { attachmentKey, decryptSecret } from "@defe2end/shared/server";
import { beforeEach, expect, it, vi } from "vitest";
import * as captureRoute from "../../app/api/w/[slug]/environments/[environmentId]/auth-session/capture/route";
import * as authSessionRoute from "../../app/api/desktop/auth-sessions/route";
import * as attachmentRoute from "../../app/api/desktop/runs/[id]/attachments/[attachmentId]/route";
import * as artifactRoute from "../../app/api/desktop/runs/[id]/artifacts/[kind]/[attempt]/[key]/route";
import * as completeRoute from "../../app/api/desktop/runs/[id]/complete/route";
import * as heartbeatRoute from "../../app/api/desktop/runs/[id]/heartbeat/route";
import * as startRoute from "../../app/api/desktop/runs/[id]/start/route";
import * as tokenRoute from "../../app/api/desktop/token/route";
import * as sessionsRoute from "../../app/api/w/[slug]/auth-sessions/route";
import * as sessionRoute from "../../app/api/w/[slug]/auth-sessions/[sessionId]/route";
import * as groupsRoute from "../../app/api/w/[slug]/groups/route";
import * as cancelRoute from "../../app/api/w/[slug]/runs/[id]/cancel/route";
import * as runsRoute from "../../app/api/w/[slug]/runs/route";
import * as stopAllRoute from "../../app/api/w/[slug]/runs/stop-all/route";
import { AUTH_SESSION_MAX_BYTES, authSessionExpiry } from "../auth-sessions";
import { describeDb, resetDatabase } from "../../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../../test/helpers";
import { getDb } from "../db";
import { getEncryptionKey } from "../encryption";
import { getStorage } from "../storage";
import { openDesktopStream, type DesktopStreamSession } from "./stream";

const ORIGIN = new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000").origin;
const INSTALL = "8b0f5f7e-2a4c-4c1e-9d55-0a4c5c7a1b12";
const cookie = (over: Record<string, unknown> = {}) => ({ name: "sid", value: "s3cr3t-cookie", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const, ...over }) as StorageState["cookies"][number];
const state = (cookies = [cookie()]) => ({ cookies, origins: [] });

describeDb("desktop server, round 2", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let editor: Headers;
  let environment: { id: string };
  let scenarios: { id: string }[];
  let token: string;
  let session: DesktopStreamSession;

  beforeEach(async () => {
    await resetDatabase();
    process.env.MIN_FREE_DISK_MB = "0";
    ctx = await workspaceWithRoles();
    editor = await sessionHeaders(ctx.users.EDITOR.id);
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    environment = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://shop.example.com" } });
    scenarios = [];
    for (const name of ["a", "b"]) scenarios.push(await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name, steps: [{ id: "s1", action: "goto", url: `/${name}` }] } }));
    token = (await tokenFor(editor)).token;
    session = await connect(token);
  });

  async function tokenFor(headers: Headers) {
    const h = new Headers(headers);
    h.set("origin", ORIGIN);
    return (await (await callRoute(tokenRoute.POST, { method: "POST", headers: h, body: { installId: INSTALL, label: "ab12" } })).json()) as { token: string; deviceId: string };
  }
  async function connect(t: string, active: string[] = [], capabilities: readonly string[] = DESKTOP_CAPABILITIES) {
    const opened = await openDesktopStream(
      new Request("http://localhost:3000/api/desktop/stream", {
        headers: {
          authorization: `Bearer ${t}`,
          "defe2end-client": formatDesktopClientHeader({ app: "1.0.0", runner: "1.0.0", protocol: 1 }),
          "defe2end-capabilities": capabilities.join(","),
          "defe2end-active-runs": active.join(","),
        },
      }),
    );
    if (!opened.ok) throw new Error(`refused ${opened.response.status}`);
    return opened.session;
  }
  const app = (extra: Record<string, string> = {}) => new Headers({ authorization: `Bearer ${token}`, ...extra });
  const createRun = async (body: Record<string, unknown> = {}) => {
    const res = await callRoute(runsRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug }, headers: editor, body: { scenarioId: scenarios[0]!.id, environmentId: environment.id, location: "desktop", ...body } });
    return { res, id: res.status === 201 ? ((await res.json()) as { id: string }).id : "" };
  };
  const startRun = async (id: string) => (await (await callRoute(startRoute.POST, { method: "POST", params: { id }, headers: app() })).json()) as { status: string; claimToken?: string };
  const running = async () => {
    const { id } = await createRun();
    await session.tick();
    const { claimToken } = await startRun(id);
    return { id, claimToken: claimToken! };
  };
  const put = (id: string, claimToken: string, kind: string, key: string, body: Uint8Array, length = body.byteLength) =>
    artifactRoute.PUT(new Request(`http://localhost/x`, { method: "PUT", headers: app({ [DESKTOP_HEADERS.claimToken]: claimToken, "content-length": String(length) }), body, duplex: "half" } as RequestInit), {
      params: Promise.resolve({ id, kind, attempt: "1", key }),
    });

  it("artifact PUT stores, replaces the same key, and refuses oversize with 413", async () => {
    const { id, claimToken } = await running();
    expect((await put(id, claimToken, "screenshot", "step-0", new Uint8Array(10))).status).toBe(201);
    expect((await put(id, claimToken, "screenshot", "step-0", new Uint8Array(20))).status).toBe(201);
    const rows = await getDb().artifact.findMany({ where: { runId: id } });
    expect(rows.map((r) => [r.name, r.sizeBytes, r.stepIndex])).toEqual([["step-0", 20, 0]]);
    expect(await getStorage().stat(rows[0]!.storageKey)).toEqual({ sizeBytes: 20 });
    expect((await put(id, claimToken, "screenshot", "step-1", new Uint8Array(1), 11 * 1024 * 1024)).status).toBe(413);
    expect((await put(id, claimToken, "video", "main", new Uint8Array(1), 201 * 1024 * 1024)).status).toBe(413);
    expect((await put(id, claimToken, "video", "bad key", new Uint8Array(1))).status).toBe(400);
    expect((await put(id, "wrong", "log", "log", new Uint8Array(1))).status).toBe(409);
  });

  it("the run total holds under concurrent registrations (same key counted once)", async () => {
    const { id, claimToken } = await running();
    const run = { id, workspaceId: ctx.workspace.id, claimToken };
    const file = (n: number) => ({ storageKey: `k-${n}-${Math.random()}`, contentType: "image/png", sizeBytes: 60 });
    const results = await Promise.all([1, 2, 3].map((n) => registerDesktopArtifact(getDb(), run, { kind: "screenshot", attempt: 1, name: `step-${n}` }, file(n), 150)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.reason === "too_large")).toHaveLength(1);
    // Re-uploading a stored key replaces it: 60 + 60 stays within 150 even though three files were sent.
    const storedName = (await getDb().artifact.findFirstOrThrow({ where: { runId: id } })).name;
    const replaced = await registerDesktopArtifact(getDb(), run, { kind: "screenshot", attempt: 1, name: storedName }, file(9), 150);
    expect(replaced).toMatchObject({ ok: true, replaced: [expect.any(String)] });
  });

  it("attachment GET serves only files pinned in the snapshot", async () => {
    const storage = getStorage();
    const key = attachmentKey(ctx.workspace.id);
    await storage.put(key, (async function* () { yield new TextEncoder().encode("hello"); })());
    const att = await getDb().attachment.create({ data: { workspaceId: ctx.workspace.id, name: "f.txt", version: 1, storageKey: key, contentType: "text/plain", sizeBytes: 5 } });
    const { id } = await createRun();
    const call = (attachmentId: string) => callRoute(attachmentRoute.GET, { params: { id, attachmentId }, headers: app() });
    expect((await call(att.id)).status).toBe(404); // not pinned in this run's snapshot
    const run = await getDb().run.findUniqueOrThrow({ where: { id } });
    await getDb().run.update({ where: { id }, data: { snapshot: { ...(run.snapshot as object), attachments: [{ name: "f.txt", id: att.id, version: 1 }] } } });
    const res = await call(att.id);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  it("cancel and stop-all reach the app as stop-run, once per connection and again after a reconnect", async () => {
    const a = await running();
    await callRoute(cancelRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug, id: a.id }, headers: editor });
    expect(await session.tick()).toContainEqual({ type: "stop-run", runId: a.id });
    expect((await session.tick()).filter((m) => m.type === "stop-run")).toEqual([]);
    const hb = await callRoute(heartbeatRoute.POST, { method: "POST", params: { id: a.id }, headers: app(), body: { claimToken: a.claimToken } });
    expect((await hb.json()).cancelRequested).toBe(true);

    const b = await running();
    await callRoute(stopAllRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug }, headers: await sessionHeaders(ctx.users.ADMIN.id) });
    const again = await connect(token, [a.id, b.id]);
    const stops = (await again.tick()).filter((m) => m.type === "stop-run").map((m) => (m as { runId: string }).runId);
    expect(stops.sort()).toEqual([a.id, b.id].sort());
  });

  it("heartbeat keeps extending the lease until the completion is accepted", async () => {
    const { id, claimToken } = await running();
    await getDb().run.update({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() + 5_000) } });
    const res = await callRoute(heartbeatRoute.POST, { method: "POST", params: { id }, headers: app(), body: { claimToken } });
    expect(new Date((await res.json()).leaseExpiresAt).getTime()).toBeGreaterThan(Date.now() + 80_000);
    await callRoute(completeRoute.POST, {
      method: "POST", params: { id }, headers: app(),
      body: { claimToken, verdict: "passed", stopCause: { type: "none" }, attemptCount: 1, passedAfterRetry: false, durationMs: 1, steps: [] },
    });
    expect((await callRoute(heartbeatRoute.POST, { method: "POST", params: { id }, headers: app(), body: { claimToken } })).status).toBe(409);
  });

  it("start re-checks the sequential group: a later child doesn't start while the earlier one runs", async () => {
    const res = await callRoute(groupsRoute.POST, {
      method: "POST", params: { slug: ctx.workspace.slug }, headers: editor,
      body: { environmentId: environment.id, scenarioIds: scenarios.map((s) => s.id), mode: "sequential", continueOnFailure: false, location: "desktop" },
    });
    const { runIds } = (await res.json()) as { runIds: string[] };
    await session.tick();
    // Pretend the second child was sent too (e.g. by a racing dispatch); start must still refuse it.
    await getDb().run.update({ where: { id: runIds[1]! }, data: { dispatchedAt: new Date(), dispatchedConnectionId: session.connectionId } });
    expect(await startRun(runIds[1]!)).toEqual({ status: "queued" });
    expect((await startRun(runIds[0]!)).status).toBe("running");
    expect(await startRun(runIds[1]!)).toEqual({ status: "queued" });
  });

  it("a completion committed before the reconnect wins over reconciliation", async () => {
    const { id, claimToken } = await running();
    await callRoute(completeRoute.POST, {
      method: "POST", params: { id }, headers: app(),
      body: { claimToken, verdict: "passed", stopCause: { type: "none" }, attemptCount: 1, passedAfterRetry: false, durationMs: 1, steps: [] },
    });
    await new Promise((r) => setTimeout(r, 5));
    await connect(token, []);
    expect((await getDb().run.findUniqueOrThrow({ where: { id } })).status).toBe("passed");
  });

  it("ids of another workspace are 404: environment, device of another user, run of another user", async () => {
    const otherSite = await getDb().site.create({ data: { workspaceId: ctx.other.id, name: "X" } });
    const otherEnv = await getDb().environment.create({ data: { workspaceId: ctx.other.id, siteId: otherSite.id, name: "X", baseUrl: "https://x.example" } });
    expect((await createRun({ environmentId: otherEnv.id })).res.status).toBe(404);
    const admin = await tokenFor(await sessionHeaders(ctx.users.ADMIN.id));
    await connect(admin.token);
    const res = (await createRun({ deviceId: admin.deviceId })).res;
    expect((await res.json()).error.code).toBe("desktop_not_connected");
    const { id } = await running();
    const theirs = await callRoute(startRoute.POST, { method: "POST", params: { id }, headers: new Headers({ authorization: `Bearer ${admin.token}` }) });
    expect(theirs.status).toBe(404);
  });

  it("login sessions: encrypted, owner only, 512KB, expiry, and required ones are never borrowed", async () => {
    const register = (body: unknown, t = token) => callRoute(authSessionRoute.POST, { method: "POST", headers: new Headers({ authorization: `Bearer ${t}` }), body });
    const base = { workspaceId: ctx.workspace.id, environmentId: environment.id };
    expect((await register({ ...base, storageState: state([]) })).status).toBe(400);
    const big = state([cookie({ value: "x".repeat(AUTH_SESSION_MAX_BYTES) })]);
    expect((await register({ ...base, storageState: big })).status).toBe(413);
    const viewer = await tokenFor(await sessionHeaders(ctx.users.VIEWER.id));
    expect((await register({ ...base, storageState: state() }, viewer.token)).status).toBe(403);
    expect((await register({ ...base, workspaceId: ctx.other.id, storageState: state() })).status).toBe(404);

    // The admin saves one; the editor still has none, so a required environment refuses the editor's run.
    const admin = await tokenFor(await sessionHeaders(ctx.users.ADMIN.id));
    expect((await register({ ...base, storageState: state() }, admin.token)).status).toBe(201);
    await getDb().environment.update({ where: { id: environment.id }, data: { useAuthSession: true } });
    const missing = await createRun({ location: "server" });
    expect((await missing.res.json()).error.code).toBe("auth_session_missing");

    const saved = await register({ ...base, requestId: "r1", storageState: state() });
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({ cookieCount: 1, requestId: "r1" });
    const row = await getDb().authSession.findUniqueOrThrow({ where: { environmentId_userId: { environmentId: environment.id, userId: ctx.users.EDITOR.id } } });
    expect(row.encryptedState).not.toContain("s3cr3t-cookie");
    expect(JSON.parse(decryptSecret(row.encryptedState, getEncryptionKey())).cookies[0].value).toBe("s3cr3t-cookie");
    const audits = await getDb().auditLog.findMany({ where: { action: "authSession.save" } });
    expect(JSON.stringify(audits)).not.toContain("s3cr3t-cookie");

    const list = await (await callRoute(sessionsRoute.GET, { params: { slug: ctx.workspace.slug }, headers: editor })).json();
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("s3cr3t");
    const adminRow = await getDb().authSession.findFirstOrThrow({ where: { userId: ctx.users.ADMIN.id } });
    expect((await callRoute(sessionRoute.DELETE, { method: "DELETE", params: { slug: ctx.workspace.slug, sessionId: adminRow.id }, headers: editor })).status).toBe(404);

    // With its own session the desktop run carries it; expired = absent.
    const { id } = await createRun();
    const [message] = await session.tick();
    expect(message).toMatchObject({ type: "run", runId: id, plan: { storageState: { cookies: [{ value: "s3cr3t-cookie" }] } } });
    await getDb().authSession.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await (await createRun()).res.json()).error.code).toBe("auth_session_missing");
    expect((await callRoute(sessionRoute.DELETE, { method: "DELETE", params: { slug: ctx.workspace.slug, sessionId: row.id }, headers: editor })).status).toBe(204);
  });

  it("expiry is the earlier of 30 days and the latest expiring target-host cookie", () => {
    const savedAt = new Date("2026-01-01T00:00:00Z");
    const in3days = savedAt.getTime() / 1000 + 3 * 86400;
    const other = cookie({ domain: "tracker.example.net", expires: in3days + 999 });
    expect(authSessionExpiry(state([cookie({ expires: in3days }), other]), "https://shop.example.com", savedAt).getTime()).toBe(in3days * 1000);
    expect(authSessionExpiry(state([cookie()]), "https://shop.example.com", savedAt).getTime()).toBe(savedAt.getTime() + 30 * 86400_000);
  });

  it("capture-auth-state goes to the caller's connected app", async () => {
    const res = await callRoute(captureRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug, environmentId: environment.id }, headers: editor });
    expect(res.status).toBe(202);
    const { requestId } = await res.json();
    expect(await session.tick()).toContainEqual({ type: "capture-auth-state", requestId, workspaceId: ctx.workspace.id, environmentId: environment.id, url: "https://shop.example.com" });
    const viewer = await callRoute(captureRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug, environmentId: environment.id }, headers: await sessionHeaders(ctx.users.VIEWER.id) });
    expect(viewer.status).toBe(403);
  });

  it("review 1: a requester who left the workspace can't start, read attachments or keep a run going", async () => {
    const queued = await createRun();
    await session.tick();
    const live = await running();
    await getDb().membership.delete({ where: { userId_workspaceId: { userId: ctx.users.EDITOR.id, workspaceId: ctx.workspace.id } } });
    expect((await callRoute(startRoute.POST, { method: "POST", params: { id: queued.id }, headers: app() })).status).toBe(404);
    expect((await callRoute(attachmentRoute.GET, { params: { id: live.id, attachmentId: "x" }, headers: app() })).status).toBe(404);
    const hb = await callRoute(heartbeatRoute.POST, { method: "POST", params: { id: live.id }, headers: app(), body: { claimToken: live.claimToken } });
    expect(hb.status).toBe(404);
    for (const id of [queued.id, live.id]) {
      expect(await getDb().run.findUniqueOrThrow({ where: { id }, select: { status: true, errorCode: true } })).toEqual({ status: "error", errorCode: "permission_lost" });
    }
  });

  it("review 2: a dispatch racing a reconnect never leaves a run sent on a stale connection", async () => {
    for (let i = 0; i < 8; i++) {
      const old = await connect(token);
      const { id } = await createRun();
      const [, fresh] = await Promise.all([old.tick(), connect(token, [])]);
      const run = await getDb().run.findUniqueOrThrow({ where: { id } });
      const stuck = run.status === "queued" && run.dispatchedAt !== null && run.dispatchedConnectionId !== fresh.connectionId;
      expect(stuck, `round ${i}: ${run.status} ${run.dispatchedConnectionId}`).toBe(false);
      await getDb().run.update({ where: { id }, data: { status: "cancelled" } });
    }
  });

  it("review 3: an app that reconnected with fewer capabilities gets no run; the run ends app_update_required", async () => {
    const { id } = await createRun();
    const lesser = await connect(token, [], DESKTOP_CAPABILITIES.filter((c) => c !== "goto"));
    expect((await lesser.tick()).filter((m) => m.type === "run")).toEqual([]);
    expect(await getDb().run.findUniqueOrThrow({ where: { id }, select: { status: true, errorCode: true, dispatchedAt: true } })).toEqual({ status: "error", errorCode: "app_update_required", dispatchedAt: null });
  });

  it("round 4 #1: start and heartbeat report leaseRemainingMs; a repeated start renews the lease", async () => {
    const { id } = await createRun();
    await session.tick();
    const first = await (await callRoute(startRoute.POST, { method: "POST", params: { id }, headers: app() })).json();
    expect(first.leaseRemainingMs).toBeGreaterThan(80_000);
    await getDb().run.update({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() + 5_000) } });
    const again = await (await callRoute(startRoute.POST, { method: "POST", params: { id }, headers: app() })).json();
    expect(again).toMatchObject({ status: "running", claimToken: first.claimToken });
    expect(again.leaseRemainingMs).toBeGreaterThan(80_000);
    expect((await getDb().run.findUniqueOrThrow({ where: { id } })).leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 80_000);
    const hb = await (await callRoute(heartbeatRoute.POST, { method: "POST", params: { id }, headers: app(), body: { claimToken: first.claimToken } })).json();
    expect(hb.leaseRemainingMs).toBeGreaterThan(80_000);
    expect(hb.leaseRemainingMs).toBeLessThanOrEqual(90_000);
  });

  it("round 4 #2: DELETE /api/desktop/token with a bearer revokes that token only; with a web session, all", async () => {
    const second = await tokenFor(editor);
    const del = (headers: Headers) => callRoute(tokenRoute.DELETE, { method: "DELETE", headers });
    expect((await del(new Headers({ authorization: "Bearer nope" }))).status).toBe(401);
    expect((await del(new Headers({ authorization: `Bearer ${token}` }))).status).toBe(204);
    const live = await getDb().desktopToken.findMany({ where: { userId: ctx.users.EDITOR.id, revokedAt: null } });
    expect(live).toHaveLength(1);
    expect((await callRoute(startRoute.POST, { method: "POST", params: { id: "x" }, headers: new Headers({ authorization: `Bearer ${second.token}` }) })).status).toBe(404);
    const web = new Headers(editor);
    web.set("origin", ORIGIN);
    expect((await del(web)).status).toBe(204);
    expect(await getDb().desktopToken.count({ where: { userId: ctx.users.EDITOR.id, revokedAt: null } })).toBe(0);
  });

  it("round 4 #3: only the current connection takes a capture request; a failed write puts it back", async () => {
    const capture = () => callRoute(captureRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug, environmentId: environment.id }, headers: editor });
    const old = session;
    const fresh = await connect(token);
    const { requestId } = await (await capture()).json();
    const [fromOld, fromFresh] = await Promise.all([old.tick(), fresh.tick()]);
    expect(fromOld).toEqual([]);
    const taken = fromFresh.find((m) => m.type === "capture-auth-state");
    expect(taken).toMatchObject({ requestId });
    await fresh.written(taken!, false);
    const retried = await fresh.tick();
    expect(retried.find((m) => m.type === "capture-auth-state")).toMatchObject({ requestId });
    await fresh.written(retried.find((m) => m.type === "capture-auth-state")!, true);
    expect((await fresh.tick()).filter((m) => m.type === "capture-auth-state")).toEqual([]);
  });

  it("round 5: a capture request taken in a tick that fails later is put back, not lost", async () => {
    const { requestId } = await (await callRoute(captureRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug, environmentId: environment.id }, headers: editor })).json();
    const spy = vi.spyOn(getDb().run, "findMany").mockRejectedValueOnce(new Error("db down"));
    await expect(session.tick()).rejects.toThrow("db down");
    spy.mockRestore();
    expect(await getDb().desktopCaptureRequest.count()).toBe(1);
    const retried = await session.tick();
    expect(retried.find((m) => m.type === "capture-auth-state")).toMatchObject({ requestId });
    // Taken but the stream ended before writing it: restoreUnwritten (the stream's finally) puts it back.
    await session.restoreUnwritten();
    expect(await getDb().desktopCaptureRequest.count()).toBe(1);
  });
});
