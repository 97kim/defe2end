// Stage 6 review fixes: refresh/exchange vs revocation share the device row lock and re-check after locking;
// `get_run` waits re-check the token and membership on every poll.
import { beforeEach, expect, it } from "vitest";
import * as mcpExchange from "../../app/api/desktop/mcp-token/route";
import * as mcpRuns from "../../app/api/mcp/w/[slug]/runs/[id]/route";
import * as mcpToken from "../../app/api/mcp/token/route";
import { describeDb, resetDatabase } from "../../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../../test/helpers";
import { getDb } from "../db";
import { hashDesktopToken, issueDesktopToken } from "../desktop/auth";
import { issueMcpToken, lockMcpDevices, revokeMcpTokens } from "./auth";

const INSTALL = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ORIGIN = new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000").origin;

describeDb("MCP token races", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let deviceId: string;
  let token: string;
  let desktopToken: string;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    const desktop = await issueDesktopToken({ userId: ctx.users.EDITOR.id, installId: INSTALL, label: "abcd" });
    deviceId = desktop.deviceId;
    desktopToken = desktop.token;
    token = (await issueMcpToken(getDb(), { userId: ctx.users.EDITOR.id, deviceId })).token;
  });

  const bearer = (raw: string) => new Headers({ authorization: `Bearer ${raw}` });
  /** Waits until some other connection is blocked on a row lock. */
  async function untilBlocked() {
    for (let i = 0; i < 100; i++) {
      const [row] = await getDb().$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_locks WHERE NOT granted`;
      if (Number(row!.n) > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("nothing blocked on the lock");
  }
  const liveTokens = () => getDb().mcpToken.count({ where: { deviceId, OR: [{ revokedAt: null }, { revokedAt: { gt: new Date() } }] } });

  it("a refresh waiting for the lock gets no token when a revocation commits first", async () => {
    let refresh!: Promise<Response>;
    await getDb().$transaction(
      async (tx) => {
        await lockMcpDevices(tx, { deviceId });
        refresh = callRoute(mcpToken.POST, { method: "POST", headers: bearer(token) });
        await untilBlocked();
        await tx.mcpToken.updateMany({ where: { deviceId }, data: { revokedAt: new Date() } });
      },
      { timeout: 15_000 },
    );
    expect((await refresh).status).toBe(401);
    expect(await liveTokens()).toBe(0);
  });

  it("a revocation waits for a refresh holding the lock, then revokes the new token too", async () => {
    let revoke!: Promise<number>;
    await getDb().$transaction(
      async (tx) => {
        await lockMcpDevices(tx, { deviceId });
        revoke = revokeMcpTokens(getDb(), { userId: ctx.users.EDITOR.id });
        await untilBlocked();
        await issueMcpToken(tx, { userId: ctx.users.EDITOR.id, deviceId });
      },
      { timeout: 15_000 },
    );
    expect(await revoke).toBe(2);
    expect(await liveTokens()).toBe(0);
  });

  it("an exchange waiting for the lock fails when sign-out commits first", async () => {
    const cookie = await sessionHeaders(ctx.users.EDITOR.id);
    cookie.set("origin", ORIGIN);
    let exchange!: Promise<Response>;
    await getDb().$transaction(
      async (tx) => {
        await lockMcpDevices(tx, { deviceId });
        exchange = callRoute(mcpExchange.POST, { method: "POST", headers: cookie, body: { installId: INSTALL, desktopToken } });
        await untilBlocked();
        await tx.session.deleteMany({ where: { userId: ctx.users.EDITOR.id } });
        await tx.mcpToken.updateMany({ where: { deviceId }, data: { revokedAt: new Date() } });
      },
      { timeout: 15_000 },
    );
    expect((await exchange).status).toBe(401);
    expect(await liveTokens()).toBe(0);
  });

  it("an exchange waiting for the lock fails when a server change revoked the desktop token first (web session kept)", async () => {
    const cookie = await sessionHeaders(ctx.users.EDITOR.id);
    cookie.set("origin", ORIGIN);
    await getDb().mcpToken.updateMany({ where: { deviceId }, data: { revokedAt: new Date() } });
    let exchange!: Promise<Response>;
    await getDb().$transaction(
      async (tx) => {
        await lockMcpDevices(tx, { deviceId });
        exchange = callRoute(mcpExchange.POST, { method: "POST", headers: cookie, body: { installId: INSTALL, desktopToken } });
        await untilBlocked();
        // What `DELETE /api/desktop/token` with the desktop token does on a server change: that token and the device's MCP tokens.
        await tx.desktopToken.updateMany({ where: { tokenHash: hashDesktopToken(desktopToken) }, data: { revokedAt: new Date() } });
      },
      { timeout: 15_000 },
    );
    expect((await exchange).status).toBe(401);
    expect(await liveTokens()).toBe(0);
    expect(await getDb().session.count({ where: { userId: ctx.users.EDITOR.id } })).toBeGreaterThan(0);
  });

  it("get_run wait stops with 401 once the user leaves the workspace or the token is revoked", async () => {
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    const scenario = await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "a", steps: [] } });
    const run = await db.run.create({
      data: {
        workspaceId: ctx.workspace.id, scenarioId: scenario.id, trigger: "manual", status: "running",
        snapshot: { scenario: { id: scenario.id, name: "a", stepFormatVersion: 1, steps: [] }, environment: { id: "e", name: "Staging", baseUrl: "https://shop.example.com" }, device: { viewport: { width: 1280, height: 720 } }, attachments: [], variableKeys: [] },
        queuedAt: new Date(),
      },
    });
    const get = () => callRoute(mcpRuns.GET, { headers: bearer(token), path: "/x?wait=10", params: { slug: ctx.workspace.slug, id: run.id } });

    let started = Date.now();
    let pending = get();
    await new Promise((r) => setTimeout(r, 300));
    await db.membership.deleteMany({ where: { userId: ctx.users.EDITOR.id, workspaceId: ctx.workspace.id } });
    expect((await pending).status).toBe(401);
    expect(Date.now() - started).toBeLessThan(5_000);

    await db.membership.create({ data: { userId: ctx.users.EDITOR.id, workspaceId: ctx.workspace.id, role: "EDITOR" } });
    started = Date.now();
    pending = get();
    await new Promise((r) => setTimeout(r, 300));
    await revokeMcpTokens(db, { deviceId });
    expect((await pending).status).toBe(401);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);
});
