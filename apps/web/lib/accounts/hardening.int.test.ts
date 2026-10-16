// Regression tests for the stage-2 review findings in accounts: first-admin race, atomic setup,
// last *active* admin, and the public link APIs (token checked before hashing, per-IP rate limit).
import { createDbClient } from "@defe2end/db";
import { beforeEach, expect, it, vi } from "vitest";
import { describeDb, resetDatabase } from "../../test/db";
import { addMember, callRoute, createUser, createWorkspace, sessionHeaders } from "../../test/helpers";
import * as member from "../../app/api/w/[slug]/members/[id]/route";
import * as adminUser from "../../app/api/admin/users/[id]/route";
import * as inviteRoute from "../../app/api/invite/route";
import * as resetRoute from "../../app/api/reset/route";
import { createAdminCommand, ADMIN_MEMBERSHIP_LOCK as CLI_LOCK } from "../../cli/defe2end.mjs";
import { getAuth } from "../auth";
import { getDb } from "../db";
import { completeSetup } from "../setup";
import { ADMIN_MEMBERSHIP_LOCK } from "./admin-lock";
import { issueInstallToken } from "../startup";

beforeEach(resetDatabase);

describeDb("first instance admin", () => {
  it("web setup and the CLI take the same lock", () => {
    expect(CLI_LOCK).toBe(ADMIN_MEMBERSHIP_LOCK);
  });

  it("two concurrent create-admin runs create exactly one admin", async () => {
    // Separate clients = separate connections, like two `docker compose exec` runs.
    const clients = [createDbClient(), createDbClient()];
    const results = await Promise.allSettled(clients.map((db, i) => createAdminCommand(db, `admin${i}@example.com`)));
    await Promise.all(clients.map((c) => c.$disconnect()));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await getDb().user.count({ where: { isInstanceAdmin: true } })).toBe(1);
  });

  it("web setup and create-admin at the same time create exactly one admin", async () => {
    const token = (await issueInstallToken(getDb()))!;
    const cli = createDbClient();
    const results = await Promise.allSettled([
      completeSetup({ token, name: "Web Admin", email: "web@example.com", password: "a long password", workspaceName: "Shop" }),
      createAdminCommand(cli, "cli@example.com"),
    ]);
    await cli.$disconnect();
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await getDb().user.count({ where: { isInstanceAdmin: true } })).toBe(1);
  });
});

describeDb("setup is atomic", () => {
  it("a failure after the admin is created leaves nothing behind and the token still works", async () => {
    const token = (await issueInstallToken(getDb()))!;
    // Make the workspace insert fail: its slug is taken.
    await createWorkspace({ slug: "shop" });
    const input = { token, name: "First Admin", email: "admin@example.com", password: "a long password", workspaceName: "Shop" };
    await expect(completeSetup(input)).rejects.toThrow();
    expect(await getDb().user.count()).toBe(0);
    expect((await getDb().instanceSetting.findUniqueOrThrow({ where: { id: 1 } })).installTokenUsedAt).toBeNull();

    const done = await completeSetup({ ...input, workspaceName: "Shop Two" });
    expect(done.slug).toBe("shop-two");
    const admin = await getDb().user.findUniqueOrThrow({ where: { email: "admin@example.com" }, include: { memberships: true } });
    expect(admin.isInstanceAdmin).toBe(true);
    expect(admin.memberships).toHaveLength(1);
    expect((await getAuth().api.signInEmail({ body: { email: "admin@example.com", password: "a long password" }, asResponse: true })).status).toBe(200);
  });
});

describeDb("last active admin", () => {
  async function setup() {
    const ws = await createWorkspace();
    const active = await createUser();
    const disabled = await createUser();
    const activeM = await addMember(active.id, ws.id, "ADMIN");
    await addMember(disabled.id, ws.id, "ADMIN");
    await getDb().user.update({ where: { id: disabled.id }, data: { disabledAt: new Date() } });
    return { ws, active, disabled, activeM };
  }

  it("a disabled admin doesn't count: the only active admin can't be demoted or removed", async () => {
    const { ws, active, activeM } = await setup();
    const headers = await sessionHeaders(active.id);
    const params = { slug: ws.slug, id: activeM.id };
    expect((await callRoute(member.PATCH, { method: "PATCH", params, body: { role: "EDITOR" }, headers })).status).toBe(409);
    expect((await callRoute(member.DELETE, { method: "DELETE", params, headers })).status).toBe(409);
  });

  it("an instance admin can't disable the only active admin of a workspace", async () => {
    const { active } = await setup();
    const root = await createUser({ isInstanceAdmin: true });
    const res = await callRoute(adminUser.PATCH, { method: "PATCH", params: { id: active.id }, body: { disabled: true }, headers: await sessionHeaders(root.id) });
    expect(res.status).toBe(409);
    expect((await getDb().user.findUniqueOrThrow({ where: { id: active.id } })).disabledAt).toBeNull();
  });

  it("disabling is fine when another active admin remains", async () => {
    const { ws, active } = await setup();
    const second = await createUser();
    await addMember(second.id, ws.id, "ADMIN");
    const root = await createUser({ isInstanceAdmin: true });
    const res = await callRoute(adminUser.PATCH, { method: "PATCH", params: { id: active.id }, body: { disabled: true }, headers: await sessionHeaders(root.id) });
    expect(res.status).toBe(200);
  });
});

describeDb("last active admin under concurrency", () => {
  /**
   * Forces the interleaving the review found: a third connection holds the workspace's Membership rows,
   * both requests start (and read whatever they read) while it waits, then it lets go.
   */
  async function interleaved(workspaceId: string, requests: (() => Promise<Response>)[]) {
    const blocker = createDbClient();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const blocking = blocker.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Membership" WHERE "workspaceId" = ${workspaceId} ORDER BY id FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const results = requests.map((r) => r());
    await new Promise((r) => setTimeout(r, 400));
    release();
    await blocking;
    await blocker.$disconnect();
    return Promise.all(results);
  }

  const activeAdmins = (workspaceId: string) =>
    getDb().membership.count({ where: { workspaceId, role: "ADMIN", user: { disabledAt: null } } });

  async function twoAdmins() {
    const ws = await createWorkspace();
    const a = await createUser();
    const b = await createUser();
    await addMember(a.id, ws.id, "ADMIN");
    const bm = await addMember(b.id, ws.id, "ADMIN");
    const root = await createUser({ isInstanceAdmin: true });
    return { ws, a, b, bm, rootHeaders: await sessionHeaders(root.id) };
  }

  it("disabling both admins at once leaves one active admin", async () => {
    const { ws, a, b, rootHeaders } = await twoAdmins();
    const disable = (id: string) => () => callRoute(adminUser.PATCH, { method: "PATCH", params: { id }, body: { disabled: true }, headers: rootHeaders });
    const statuses = (await interleaved(ws.id, [disable(a.id), disable(b.id)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await activeAdmins(ws.id)).toBe(1);
  });

  it("disabling one admin while the other steps down leaves one active admin", async () => {
    const { ws, a, b, bm, rootHeaders } = await twoAdmins();
    const bHeaders = await sessionHeaders(b.id);
    const results = await interleaved(ws.id, [
      () => callRoute(adminUser.PATCH, { method: "PATCH", params: { id: a.id }, body: { disabled: true }, headers: rootHeaders }),
      () => callRoute(member.PATCH, { method: "PATCH", params: { slug: ws.slug, id: bm.id }, body: { role: "EDITOR" }, headers: bHeaders }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await activeAdmins(ws.id)).toBe(1);
  });
});

describeDb("last active admin: disable races with promote + demote", () => {
  it("disabling an editor while it is promoted and the other admin steps down leaves an active admin", async () => {
    const ws = await createWorkspace();
    const a = await createUser();
    const b = await createUser();
    const am = await addMember(a.id, ws.id, "ADMIN");
    const bm = await addMember(b.id, ws.id, "EDITOR");
    const root = await createUser({ isInstanceAdmin: true });
    const [rootHeaders, aHeaders] = [await sessionHeaders(root.id), await sessionHeaders(a.id)];

    // Hold B's user row so disable(B) has read the memberships (B: no ADMIN) and then waits on its update.
    const blocker = createDbClient();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const blocking = blocker.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${b.id} FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const disable = callRoute(adminUser.PATCH, { method: "PATCH", params: { id: b.id }, body: { disabled: true }, headers: rootHeaders });
    await new Promise((r) => setTimeout(r, 300));
    const promoteThenDemote = (async () => {
      const promote = await callRoute(member.PATCH, { method: "PATCH", params: { slug: ws.slug, id: bm.id }, body: { role: "ADMIN" }, headers: aHeaders });
      const demote = await callRoute(member.PATCH, { method: "PATCH", params: { slug: ws.slug, id: am.id }, body: { role: "EDITOR" }, headers: aHeaders });
      return [promote.status, demote.status];
    })();
    await new Promise((r) => setTimeout(r, 300));
    release();
    await blocking;
    await blocker.$disconnect();
    await Promise.all([disable, promoteThenDemote]);

    const active = await getDb().membership.count({ where: { workspaceId: ws.id, role: "ADMIN", user: { disabledAt: null } } });
    expect(active).toBeGreaterThanOrEqual(1);
  });
});

describeDb("public link APIs", () => {
  it("an unknown reset token is refused before the password is hashed", async () => {
    const ctx = await getAuth().$context;
    const hash = vi.spyOn(ctx.password, "hash");
    const res = await callRoute(resetRoute.POST, { method: "POST", body: { intent: "reset", token: "nope", password: "a long password" } });
    expect(res.status).toBe(404);
    expect(hash).not.toHaveBeenCalled();
    hash.mockRestore();
  });

  for (const [name, handler] of [
    ["/api/invite", inviteRoute.POST],
    ["/api/reset", resetRoute.POST],
  ] as const) {
    it(`${name} is rate limited per client IP`, async () => {
      const from = (ip: string) => callRoute(handler, { method: "POST", body: { intent: "inspect", token: "nope" }, headers: new Headers({ "x-forwarded-for": ip }) });
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) statuses.push((await from("203.0.113.7")).status);
      expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
      expect((await from("203.0.113.8")).status).toBe(200);
    });
  }
});
