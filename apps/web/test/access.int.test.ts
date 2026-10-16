// Contract section 0 and 9: generic access rules for every API route, collected from disk.
// Adding a route adds it here automatically; there is nothing to register.
import { can, ROLES, USER_ACTIONS } from "@defe2end/shared";
import { beforeAll, expect, it } from "vitest";
import { describeDb, resetDatabase } from "./db";
import { callRoute, createUser, sessionHeaders, workspaceWithRoles } from "./helpers";
import { collectRoutes, fillParams, urlFor, type RouteEntry } from "./route-inventory";

/**
 * Routes that deliberately skip route() (no session, or guarded by a link token).
 * Adding one here is a security decision: tell the lead.
 */
const PUBLIC_ROUTES = ["/api/auth/[...all]", "/api/desktop/config", "/api/health", "/api/invite", "/api/reset", "/api/setup"];

const routes = await collectRoutes();
const workspaceRoutes = routes.filter((r) => r.path.startsWith("/api/w/"));
// User actions (`desktop.connect`, `account.write`) are allowed to every signed-in user, so they have no admin-only check.
const instanceRoutes = routes.filter((r) => r.spec?.resource === "instance" && !(USER_ACTIONS as readonly string[]).includes(r.spec.action));
/** Desktop app routes authenticate with a bearer token (`desktopRoute()`), not the session cookie. */
const desktopTokenRoutes = routes.filter((r) => (r.handler as { desktopAuth?: boolean }).desktopAuth === true);
/** CI API routes authenticate with a bot token (`botRoute()`); stage 5 contract section 7. */
const botTokenRoutes = routes.filter((r) => (r.handler as { botAuth?: boolean }).botAuth === true);
/** The desktop app's MCP token routes (`mcpRoute()`); stage 6 contract section 3. */
const mcpTokenRoutes = routes.filter((r) => (r.handler as { mcpAuth?: boolean }).mcpAuth === true);
const name = (r: RouteEntry) => `${r.method} ${r.path}`;

it("every API route is wrapped with route() or listed as public", () => {
  const unwrapped = routes.filter((r) => !r.spec && !PUBLIC_ROUTES.includes(r.path) && !desktopTokenRoutes.includes(r) && !botTokenRoutes.includes(r)).map(name);
  for (const r of desktopTokenRoutes) expect(r.path, name(r)).toMatch(/^\/api\/desktop\//);
  for (const r of botTokenRoutes) expect(r.path, name(r)).toMatch(/^\/api\/v1\//);
  // `/api/mcp/*` is MCP-token-only, and MCP tokens open nothing else.
  for (const r of routes.filter((r) => r.path.startsWith("/api/mcp/"))) expect(mcpTokenRoutes, name(r)).toContain(r);
  for (const r of mcpTokenRoutes) expect(r.path, name(r)).toMatch(/^\/api\/mcp\//);
  // No destructive operation is reachable over MCP (stage 6 contract section 4); revoking one's own token is not one.
  for (const r of mcpTokenRoutes) if (r.path !== "/api/mcp/token") expect(r.method, name(r)).not.toBe("DELETE");
  expect(unwrapped).toEqual([]);
  expect(workspaceRoutes.length).toBeGreaterThan(0);
  for (const r of workspaceRoutes) {
    expect(r.path, name(r)).toMatch(/^\/api\/w\/\[slug\]/);
    expect(r.spec?.resource, name(r)).not.toBe("instance");
    // Writes need a write action, so viewers are refused (contract section 0).
    if (r.method !== "GET") expect(r.spec?.action, name(r)).not.toBe("workspace.read");
  }
});

describeDb("workspace routes", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  const headers: Record<string, Headers> = {};

  beforeAll(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    for (const [who, user] of Object.entries(ctx.users)) headers[who] = await sessionHeaders(user.id);
  });

  async function call(r: RouteEntry, as: Headers | undefined, slug = ctx.workspace.slug) {
    const params = fillParams(r, slug);
    return callRoute(r.handler, { method: r.method, path: urlFor(r, params), params, headers: as, body: r.method === "GET" ? undefined : {} });
  }

  for (const r of workspaceRoutes) {
    it(`${name(r)}: signed out → 401`, async () => {
      expect((await call(r, undefined)).status).toBe(401);
    });

    it(`${name(r)}: member of another workspace → 404`, async () => {
      const res = await call(r, headers.OUTSIDER);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    });

    it(`${name(r)}: unknown workspace → 404 (same as non-member)`, async () => {
      const res = await call(r, headers.ADMIN, "no-such-workspace");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    });

    for (const role of ROLES) {
      const decision = can({ userId: "", isInstanceAdmin: false, roles: { w: role } }, r.spec!.action, { type: r.spec!.resource, workspaceId: "w" });
      // Saving an AI diagnosis is a viewer write on purpose: it needs only `run.read` (stage 6 contract section 9).
      const viewerWrite = role === "VIEWER" && r.method !== "GET" && name(r) !== "POST /api/w/[slug]/runs/[id]/diagnoses";
      if (decision !== "forbidden" && !viewerWrite) continue;
      it(`${name(r)}: ${role} → 403`, async () => {
        const res = await call(r, headers[role]);
        expect(res.status).toBe(403);
        expect((await res.json()).error.code).toBe("forbidden");
      });
    }
  }

  for (const r of desktopTokenRoutes) {
    it(`${name(r)}: no token or a session cookie only → 401`, async () => {
      const params = fillParams(r, ctx.workspace.slug);
      const opts = { method: r.method, path: urlFor(r, params), params };
      expect((await callRoute(r.handler, opts)).status).toBe(401);
      expect((await callRoute(r.handler, { ...opts, headers: headers.ADMIN })).status).toBe(401);
    });
  }

  for (const r of botTokenRoutes) {
    it(`${name(r)}: no bot token or a session cookie only → 401`, async () => {
      const params = fillParams(r, ctx.workspace.slug);
      const opts = { method: r.method, path: urlFor(r, params), params };
      expect((await callRoute(r.handler, opts)).status).toBe(401);
      expect((await callRoute(r.handler, { ...opts, headers: headers.ADMIN })).status).toBe(401);
    });
  }

  for (const r of mcpTokenRoutes) {
    it(`${name(r)}: no MCP token or a session cookie only → 401`, async () => {
      const params = fillParams(r, ctx.workspace.slug);
      const opts = { method: r.method, path: urlFor(r, params), params, body: r.method === "GET" ? undefined : {} };
      expect((await callRoute(r.handler, opts)).status).toBe(401);
      expect((await callRoute(r.handler, { ...opts, headers: headers.ADMIN })).status).toBe(401);
    });
  }

  for (const r of instanceRoutes) {
    it(`${name(r)}: non-admin → 403, signed out → 401`, async () => {
      const params = fillParams(r, ctx.workspace.slug);
      const opts = { method: r.method, path: urlFor(r, params), params, body: r.method === "GET" ? undefined : {} };
      expect((await callRoute(r.handler, opts)).status).toBe(401);
      const user = await createUser();
      expect((await callRoute(r.handler, { ...opts, headers: await sessionHeaders(user.id) })).status).toBe(403);
    });
  }
});
