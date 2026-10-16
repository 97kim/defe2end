// Stage 6 contract sections 3, 9 and 10: MCP tokens open `/api/mcp/*` only and act with their user's
// permissions; session cookies and bot tokens don't open it. Exchange, refresh overlap and revocation.
import { beforeEach, expect, it } from "vitest";
import * as mcpExchange from "../../app/api/desktop/mcp-token/route";
import * as desktopToken from "../../app/api/desktop/token/route";
import * as mcpRuns from "../../app/api/mcp/w/[slug]/runs/[id]/route";
import * as mcpScenarios from "../../app/api/mcp/w/[slug]/scenarios/route";
import * as mcpSchedule from "../../app/api/mcp/w/[slug]/schedules/[scheduleId]/route";
import * as mcpToken from "../../app/api/mcp/token/route";
import * as mcpWorkspaces from "../../app/api/mcp/workspaces/route";
import * as v1Runs from "../../app/api/v1/runs/route";
import * as webScenarios from "../../app/api/w/[slug]/scenarios/route";
import { describeDb, resetDatabase } from "../../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../../test/helpers";
import { generateBotToken } from "../api-v1";
import { getDb } from "../db";
import { issueDesktopToken, revokeUserDesktopTokens } from "../desktop/auth";
import { issueMcpToken, MCP_TOKEN_OVERLAP_MS, verifyMcpToken } from "./auth";

const INSTALL = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const INSTALL_2 = "7a2b3c4d-5e6f-4a70-8b9c-0d1e2f3a4b5c";
const ORIGIN = new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000").origin;

describeDb("MCP tokens and /api/mcp", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let site: { id: string };

  beforeEach(async () => {
    await resetDatabase();
    process.env.MIN_FREE_DISK_MB = "0";
    ctx = await workspaceWithRoles();
    site = await getDb().site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
  });

  async function tokenFor(userId: string, installId = INSTALL) {
    const device = await getDb().desktopDevice.upsert({ where: { installId_userId: { installId, userId } }, create: { installId, userId, label: "abcd" }, update: {}, select: { id: true } });
    return { ...(await issueMcpToken(getDb(), { userId, deviceId: device.id })), deviceId: device.id };
  }
  const bearer = (raw: string) => new Headers({ authorization: `Bearer ${raw}` });
  const slug = () => ctx.workspace.slug;
  const createScenario = (headers: Headers, s = slug()) => callRoute(mcpScenarios.POST, { method: "POST", headers, params: { slug: s }, body: { siteId: site.id, name: "Login" } });

  it("authentication boundary: session cookie and bot token can't open /api/mcp; an MCP token opens nothing else", async () => {
    const editor = await tokenFor(ctx.users.EDITOR.id);
    const cookie = await sessionHeaders(ctx.users.EDITOR.id);
    expect((await callRoute(mcpScenarios.GET, { headers: cookie, params: { slug: slug() } })).status).toBe(401);
    const bot = generateBotToken();
    await getDb().botToken.create({ data: { workspaceId: ctx.workspace.id, name: "CI", tokenHash: bot.tokenHash, prefix: bot.prefix, scopes: ["runs:read"], expiresAt: new Date(Date.now() + 86_400_000) } });
    expect((await callRoute(mcpScenarios.GET, { headers: bearer(bot.raw), params: { slug: slug() } })).status).toBe(401);
    expect((await callRoute(mcpScenarios.GET, { params: { slug: slug() } })).status).toBe(401);

    expect((await callRoute(mcpScenarios.GET, { headers: bearer(editor.token), params: { slug: slug() } })).status).toBe(200);
    const web = await callRoute(webScenarios.GET, { headers: bearer(editor.token), params: { slug: slug() } });
    expect(web.status).toBe(403);
    // Even with a valid session cookie alongside, the MCP token is refused on a session route.
    const both = new Headers(cookie);
    both.set("authorization", `Bearer ${editor.token}`);
    expect((await callRoute(webScenarios.GET, { headers: both, params: { slug: slug() } })).status).toBe(403);
    expect((await callRoute(v1Runs.POST, { method: "POST", headers: bearer(editor.token), body: {} })).status).toBe(403);
  });

  it("acts as its user: viewer writes 403, another workspace 404, editor writes; workspaces are the user's", async () => {
    const viewer = await tokenFor(ctx.users.VIEWER.id);
    const editor = await tokenFor(ctx.users.EDITOR.id);
    const outsider = await tokenFor(ctx.users.OUTSIDER.id);
    expect((await createScenario(bearer(viewer.token))).status).toBe(403);
    expect((await callRoute(mcpScenarios.GET, { headers: bearer(outsider.token), params: { slug: slug() } })).status).toBe(404);
    expect((await createScenario(bearer(outsider.token))).status).toBe(404);
    const created = await createScenario(bearer(editor.token));
    expect(created.status).toBe(201);

    const list = await (await callRoute(mcpWorkspaces.GET, { headers: bearer(outsider.token) })).json();
    expect(list.workspaces).toEqual([expect.objectContaining({ slug: ctx.other.slug, role: "ADMIN" })]);
  });

  it("update_schedule refuses an environment change; get_run waits at most 25 seconds", async () => {
    const db = getDb();
    const editor = await tokenFor(ctx.users.EDITOR.id);
    const env = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://shop.example.com" } });
    const other = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Prod", baseUrl: "https://shop.example.com" } });
    const scenario = await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "a", steps: [] } });
    const schedule = await db.schedule.create({ data: { workspaceId: ctx.workspace.id, name: "Nightly", environmentId: env.id, scenarioIds: [scenario.id], cron: "0 2 * * *", timezone: "UTC" } });
    const params = { slug: slug(), scheduleId: schedule.id };
    expect((await callRoute(mcpSchedule.PATCH, { method: "PATCH", headers: bearer(editor.token), params, body: { environmentId: other.id } })).status).toBe(403);
    expect((await callRoute(mcpSchedule.PATCH, { method: "PATCH", headers: bearer(editor.token), params, body: { confirmValueReset: true } })).status).toBe(400);
    const off = await callRoute(mcpSchedule.PATCH, { method: "PATCH", headers: bearer(editor.token), params, body: { enabled: false } });
    expect(off.status).toBe(200);
    expect((await off.json()).enabled).toBe(false);
    expect((await callRoute(mcpRuns.GET, { headers: bearer(editor.token), path: "/x?wait=26", params: { slug: slug(), id: "r" } })).status).toBe(400);
  });

  it("exchange with the session cookie, refresh overlap, and revocation on logout, sign-out and expiry", async () => {
    const db = getDb();
    const cookie = await sessionHeaders(ctx.users.EDITOR.id);
    const h = new Headers(cookie);
    h.set("origin", ORIGIN);
    expect((await callRoute(mcpExchange.POST, { method: "POST", headers: h, body: { installId: INSTALL_2, desktopToken: "x" } })).status).toBe(404);
    const desktop = await issueDesktopToken({ userId: ctx.users.EDITOR.id, installId: INSTALL, label: "abcd" });
    const device = { id: desktop.deviceId };
    // The device generation is proven with its live desktop token.
    expect((await callRoute(mcpExchange.POST, { method: "POST", headers: h, body: { installId: INSTALL } })).status).toBe(400);
    expect((await callRoute(mcpExchange.POST, { method: "POST", headers: h, body: { installId: INSTALL, desktopToken: "wrong" } })).status).toBe(401);
    const bad = new Headers(cookie);
    bad.set("origin", "https://evil.example.com");
    expect((await callRoute(mcpExchange.POST, { method: "POST", headers: bad, body: { installId: INSTALL, desktopToken: desktop.token } })).status).toBe(403);
    const exchanged = await callRoute(mcpExchange.POST, { method: "POST", headers: h, body: { installId: INSTALL, desktopToken: desktop.token, clientHint: "claude" } });
    expect(exchanged.status).toBe(201);
    const first = await exchanged.json();
    expect(first.token).toMatch(/^mcp_/);
    expect(first.deviceId).toBe(device.id);
    expect(Math.round((new Date(first.expiresAt).getTime() - Date.now()) / 86_400_000)).toBe(30);

    // Refresh: the old token keeps working until the new one is used, then for one more minute.
    const refreshed = await (await callRoute(mcpToken.POST, { method: "POST", headers: bearer(first.token) })).json();
    expect(await verifyMcpToken(first.token)).not.toBeNull();
    expect(await verifyMcpToken(refreshed.token)).not.toBeNull();
    const old = await db.mcpToken.findFirstOrThrow({ where: { prefix: first.token.slice(0, 8) } });
    expect(old.revokedAt!.getTime()).toBeGreaterThan(Date.now() + MCP_TOKEN_OVERLAP_MS - 5_000);
    expect(await verifyMcpToken(first.token)).not.toBeNull();
    await db.mcpToken.update({ where: { id: old.id }, data: { revokedAt: new Date(Date.now() - 1) } });
    expect(await verifyMcpToken(first.token)).toBeNull();
    expect(await verifyMcpToken(refreshed.token)).not.toBeNull();

    // App logout revokes its own token.
    expect((await callRoute(mcpToken.DELETE, { method: "DELETE", headers: bearer(refreshed.token) })).status).toBe(204);
    expect(await verifyMcpToken(refreshed.token)).toBeNull();

    // Web sign-out / account disabled (shared with the desktop tokens) and expiry.
    const again = await tokenFor(ctx.users.EDITOR.id);
    await revokeUserDesktopTokens(ctx.users.EDITOR.id);
    expect(await verifyMcpToken(again.token)).toBeNull();
    const expiring = await tokenFor(ctx.users.EDITOR.id, INSTALL_2);
    await db.mcpToken.updateMany({ where: { deviceId: expiring.deviceId }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect(await verifyMcpToken(expiring.token)).toBeNull();
    const disabled = await tokenFor(ctx.users.VIEWER.id);
    await db.user.update({ where: { id: ctx.users.VIEWER.id }, data: { disabledAt: new Date() } });
    expect(await verifyMcpToken(disabled.token)).toBeNull();
  });

  it("app logout with the desktop token revokes that device's MCP tokens", async () => {
    const cookie = await sessionHeaders(ctx.users.EDITOR.id);
    const h = new Headers(cookie);
    h.set("origin", ORIGIN);
    const desktop = await (await callRoute(desktopToken.POST, { method: "POST", headers: h, body: { installId: INSTALL, label: "abcd" } })).json();
    const mcp = await tokenFor(ctx.users.EDITOR.id, INSTALL);
    expect((await callRoute(desktopToken.DELETE, { method: "DELETE", headers: bearer(desktop.token) })).status).toBe(204);
    expect(await verifyMcpToken(mcp.token)).toBeNull();
  });
});
