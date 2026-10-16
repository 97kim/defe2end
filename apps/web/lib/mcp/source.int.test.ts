// Stage 6 contract section 4: scenarios created, changed or copied over /api/mcp record `mcp:<client>` from the
// relay's X-Defe2end-Client header; session routes leave the source alone.
import { beforeEach, expect, it } from "vitest";
import * as mcpScenario from "../../app/api/mcp/w/[slug]/scenarios/[id]/route";
import * as mcpDuplicate from "../../app/api/mcp/w/[slug]/scenarios/[id]/duplicate/route";
import * as mcpScenarios from "../../app/api/mcp/w/[slug]/scenarios/route";
import * as webScenario from "../../app/api/w/[slug]/scenarios/[id]/route";
import * as webScenarios from "../../app/api/w/[slug]/scenarios/route";
import { describeDb, resetDatabase } from "../../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../../test/helpers";
import { getDb } from "../db";
import { issueMcpToken } from "./auth";

describeDb("scenario source over MCP", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let site: { id: string };
  let token: string;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    site = await getDb().site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    const userId = ctx.users.EDITOR.id;
    const device = await getDb().desktopDevice.create({ data: { installId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", userId, label: "abcd" } });
    token = (await issueMcpToken(getDb(), { userId, deviceId: device.id })).token;
  });

  const headers = (client?: string) => {
    const h = new Headers({ authorization: `Bearer ${token}` });
    if (client) h.set("x-defe2end-client", client);
    return h;
  };
  const source = async (id: string) => (await getDb().scenario.findUniqueOrThrow({ where: { id }, select: { source: true } })).source;
  const slug = () => ctx.workspace.slug;

  it("create, update and clone record the client; a missing or odd header is unknown", async () => {
    const created = await callRoute(mcpScenarios.POST, { method: "POST", headers: headers("claude"), params: { slug: slug() }, body: { siteId: site.id, name: "Login" } });
    expect(created.status).toBe(201);
    const scenario = await created.json();
    expect(await source(scenario.id)).toBe("mcp:claude");

    const updated = await callRoute(mcpScenario.PATCH, { method: "PATCH", headers: headers("codex"), params: { slug: slug(), id: scenario.id }, body: { updatedAt: scenario.updatedAt, name: "Login 2" } });
    expect(updated.status).toBe(200);
    expect(await source(scenario.id)).toBe("mcp:codex");

    const copy = await callRoute(mcpDuplicate.POST, { method: "POST", headers: headers(), params: { slug: slug(), id: scenario.id } });
    expect(copy.status).toBe(201);
    expect(await source((await copy.json()).id)).toBe("mcp:unknown");

    const odd = await callRoute(mcpScenarios.POST, { method: "POST", headers: headers("cursor"), params: { slug: slug() }, body: { siteId: site.id, name: "Odd" } });
    expect(await source((await odd.json()).id)).toBe("mcp:unknown");
  });

  it("session routes don't set or change the source, even with the header", async () => {
    const cookie = await sessionHeaders(ctx.users.EDITOR.id);
    cookie.set("x-defe2end-client", "claude");
    const created = await callRoute(webScenarios.POST, { method: "POST", headers: cookie, params: { slug: slug() }, body: { siteId: site.id, name: "Web" } });
    const scenario = await created.json();
    expect(await source(scenario.id)).toBeNull();

    const viaMcp = await callRoute(mcpScenario.PATCH, { method: "PATCH", headers: headers("claude"), params: { slug: slug(), id: scenario.id }, body: { updatedAt: scenario.updatedAt, name: "Web 2" } });
    const after = await viaMcp.json();
    expect(await source(scenario.id)).toBe("mcp:claude");
    await callRoute(webScenario.PATCH, { method: "PATCH", headers: cookie, params: { slug: slug(), id: scenario.id }, body: { updatedAt: after.updatedAt, name: "Web 3" } });
    expect(await source(scenario.id)).toBe("mcp:claude");
  });
});
