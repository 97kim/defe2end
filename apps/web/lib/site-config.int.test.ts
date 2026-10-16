import { beforeAll, describe, expect, it, vi } from "vitest";
import * as workspaceRoute from "../app/api/w/[slug]/route";
import * as environmentRoute from "../app/api/w/[slug]/environments/[environmentId]/route";
import * as variablesRoute from "../app/api/w/[slug]/environments/[environmentId]/variables/route";
import * as siteEnvironmentsRoute from "../app/api/w/[slug]/sites/[siteId]/environments/route";
import * as siteRoute from "../app/api/w/[slug]/sites/[siteId]/route";
import * as sitesRoute from "../app/api/w/[slug]/sites/route";
import * as variableRoute from "../app/api/w/[slug]/variables/[variableId]/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { getDb } from "./db";
import { decrypt } from "./encryption";

const SECRET = "s3cr3t-hunter2-value";
const SECRET_2 = "another-secret-value-42";

describeDb("sites, environments and variables", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  const h: Record<string, Headers> = {};

  beforeAll(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    for (const [who, user] of Object.entries(ctx.users)) h[who] = await sessionHeaders(user.id);
  });

  type Handler = Parameters<typeof callRoute>[0];
  async function call(handler: Handler, opts: { method?: string; params?: Record<string, string>; body?: unknown; as?: string; slug?: string } = {}) {
    const res = await callRoute(handler, {
      method: opts.method ?? "GET",
      params: { slug: opts.slug ?? ctx.workspace.slug, ...opts.params },
      body: opts.body,
      headers: h[opts.as ?? "EDITOR"],
    });
    const text = res.status === 204 ? "" : await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  }

  async function setup(slug = ctx.workspace.slug, as = "EDITOR") {
    const site = await call(sitesRoute.POST, { method: "POST", body: { name: `Shop ${Math.random()}` }, slug, as });
    expect(site.status).toBe(201);
    const env = await call(siteEnvironmentsRoute.POST, {
      method: "POST",
      params: { siteId: site.json.id },
      body: { name: "Staging", baseUrl: "https://staging.example.com" },
      slug,
      as,
    });
    expect(env.status).toBe(201);
    return { siteId: site.json.id as string, environmentId: env.json.id as string };
  }

  describe("sites and environments", () => {
    it("creates, lists, renames and deletes", async () => {
      const { siteId, environmentId } = await setup();
      const list = await call(sitesRoute.GET, { as: "VIEWER" });
      expect(list.status).toBe(200);
      const site = list.json.sites.find((s: { id: string }) => s.id === siteId);
      expect(site.environments).toEqual([{ id: environmentId, siteId, name: "Staging", baseUrl: "https://staging.example.com", useAuthSession: false }]);

      expect((await call(siteRoute.PATCH, { method: "PATCH", params: { siteId }, body: { name: "Renamed shop" } })).json.name).toBe("Renamed shop");
      const env = await call(environmentRoute.PATCH, { method: "PATCH", params: { environmentId }, body: { baseUrl: "http://localhost:8080" } });
      expect(env.json.baseUrl).toBe("http://localhost:8080");

      expect((await call(environmentRoute.DELETE, { method: "DELETE", params: { environmentId } })).status).toBe(204);
      expect((await call(siteRoute.DELETE, { method: "DELETE", params: { siteId } })).status).toBe(204);
      expect((await call(siteRoute.GET, { params: { siteId } })).status).toBe(404);
    });

    it("validates base URLs and unique names", async () => {
      const { siteId } = await setup();
      for (const baseUrl of ["ftp://example.com", "not a url", "javascript:alert(1)", "https://user:pw@example.com"]) {
        const res = await call(siteEnvironmentsRoute.POST, { method: "POST", params: { siteId }, body: { name: "Bad", baseUrl } });
        expect(res.status, baseUrl).toBe(400);
      }
      const dup = await call(siteEnvironmentsRoute.POST, { method: "POST", params: { siteId }, body: { name: "Staging", baseUrl: "https://example.com" } });
      expect(dup.status).toBe(409);
      const name = (await call(siteRoute.GET, { params: { siteId } })).json.name;
      expect((await call(sitesRoute.POST, { method: "POST", body: { name } })).status).toBe(409);
    });

    it("refuses to delete a site that scenarios use", async () => {
      const { siteId } = await setup();
      await getDb().scenario.create({ data: { workspaceId: ctx.workspace.id, siteId, name: "Checkout" } });
      expect((await call(siteRoute.DELETE, { method: "DELETE", params: { siteId } })).status).toBe(409);
    });

    it("refuses a site delete that races with a new scenario (409, scenario kept)", async () => {
      const { siteId } = await setup();
      const db = getDb();
      let scenarioId: string | undefined;
      // The pre-check sees no scenarios; one is created before the delete runs.
      const original = db.scenario.count.bind(db.scenario);
      const spy = vi.spyOn(db.scenario, "count").mockImplementationOnce((async (args: Parameters<typeof original>[0]) => {
        const n = await original(args);
        scenarioId = (await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId, name: "Raced in" } })).id;
        return n;
      }) as never);
      try {
        const res = await call(siteRoute.DELETE, { method: "DELETE", params: { siteId } });
        expect(spy).toHaveBeenCalled();
        expect(res.status).toBe(409);
        expect(res.json.error.code).toBe("conflict");
      } finally {
        spy.mockRestore();
      }
      expect(await db.scenario.findUnique({ where: { id: scenarioId! } })).not.toBeNull();
      expect(await db.site.findUnique({ where: { id: siteId } })).not.toBeNull();
    });
  });

  describe("variables", () => {
    it("never returns a secret value and stores it encrypted", async () => {
      const { environmentId } = await setup();
      const created = await call(variablesRoute.POST, { method: "POST", params: { environmentId }, body: { key: "PASSWORD", value: SECRET, isSecret: true } });
      expect(created.status).toBe(201);
      expect(created.json).toEqual({ id: expect.any(String), key: "PASSWORD", isSecret: true, scope: "shared", value: null, hasValue: true });
      const plain = await call(variablesRoute.POST, { method: "POST", params: { environmentId }, body: { key: "USER_EMAIL", value: "qa@example.com" } });
      expect(plain.json).toMatchObject({ key: "USER_EMAIL", isSecret: false, value: "qa@example.com", hasValue: true });

      const id = created.json.id as string;
      const row = await getDb().variable.findUniqueOrThrow({ where: { id } });
      expect(row.value).toBeNull();
      expect(row.valueEncrypted).toMatch(/^v1:/);
      expect(row.valueEncrypted).not.toContain(SECRET);
      expect(decrypt(row.valueEncrypted!)).toBe(SECRET);

      const responses = [
        created,
        await call(variablesRoute.GET, { params: { environmentId }, as: "VIEWER" }),
        await call(variableRoute.GET, { params: { variableId: id }, as: "ADMIN" }),
        await call(variableRoute.PATCH, { method: "PATCH", params: { variableId: id }, body: { key: "LOGIN_PASSWORD" } }),
        await call(variableRoute.PATCH, { method: "PATCH", params: { variableId: id }, body: { value: SECRET_2 } }),
        await call(variablesRoute.GET, { params: { environmentId } }),
        await call(variableRoute.GET, { params: { variableId: id } }),
      ];
      for (const res of responses) {
        expect(res.status).toBeLessThan(300);
        expect(res.text).not.toContain(SECRET);
        expect(res.text).not.toContain(SECRET_2);
      }
      expect(responses.at(-1)!.json).toEqual({ id, key: "LOGIN_PASSWORD", isSecret: true, scope: "shared", value: null, hasValue: true });
      // Key rename kept the stored secret; the replace changed it.
      expect(decrypt((await getDb().variable.findUniqueOrThrow({ where: { id } })).valueEncrypted!)).toBe(SECRET_2);

      const logs = await getDb().auditLog.findMany({ where: { workspaceId: ctx.workspace.id } });
      expect(logs.some((l) => l.action === "variable.update")).toBe(true);
      const dump = JSON.stringify(logs);
      expect(dump).not.toContain(SECRET);
      expect(dump).not.toContain(SECRET_2);
      expect(dump).not.toContain("qa@example.com");
    });

    it("needs a new value to make a secret non-secret, and encrypts a value made secret", async () => {
      const { environmentId } = await setup();
      const v = await call(variablesRoute.POST, { method: "POST", params: { environmentId }, body: { key: "TOKEN", value: SECRET, isSecret: true } });
      const variableId = v.json.id as string;
      expect((await call(variableRoute.PATCH, { method: "PATCH", params: { variableId }, body: { isSecret: false } })).status).toBe(400);
      const unsecret = await call(variableRoute.PATCH, { method: "PATCH", params: { variableId }, body: { isSecret: false, value: "public" } });
      expect(unsecret.json).toMatchObject({ isSecret: false, value: "public" });
      expect((await getDb().variable.findUniqueOrThrow({ where: { id: variableId } })).valueEncrypted).toBeNull();

      const resecret = await call(variableRoute.PATCH, { method: "PATCH", params: { variableId }, body: { isSecret: true } });
      expect(resecret.json).toEqual({ id: variableId, key: "TOKEN", isSecret: true, scope: "shared", value: null, hasValue: true });
      const row = await getDb().variable.findUniqueOrThrow({ where: { id: variableId } });
      expect(row.value).toBeNull();
      expect(decrypt(row.valueEncrypted!)).toBe("public");
    });

    it("validates keys, values and duplicates", async () => {
      const { environmentId } = await setup();
      for (const key of ["", "has space", "dash-key", "a".repeat(65)]) {
        expect((await call(variablesRoute.POST, { method: "POST", params: { environmentId }, body: { key, value: "x" } })).status, key).toBe(400);
      }
      // Keys may start with a digit, like `{{1USER}}` in a step (action spec 2.6).
      expect((await call(variablesRoute.POST, { method: "POST", params: { environmentId }, body: { key: "1USER", value: "x" } })).status).toBe(201);
      expect((await call(variablesRoute.POST, { method: "POST", params: { environmentId }, body: { key: "EMPTY", value: "", isSecret: true } })).status).toBe(400);
      expect((await call(variablesRoute.POST, { method: "POST", params: { environmentId }, body: { key: "BASE", value: "a" } })).status).toBe(201);
      const dup = await call(variablesRoute.POST, { method: "POST", params: { environmentId }, body: { key: "BASE", value: SECRET, isSecret: true } });
      expect(dup.status).toBe(409);
      expect(dup.text).not.toContain(SECRET);
    });
  });

  describe("ids from another workspace", () => {
    it("answer 404 on every route under my slug", async () => {
      const theirs = await setup(ctx.other.slug, "OUTSIDER");
      const theirVar = await call(variablesRoute.POST, {
        method: "POST",
        params: { environmentId: theirs.environmentId },
        body: { key: "THEIR_SECRET", value: SECRET, isSecret: true },
        slug: ctx.other.slug,
        as: "OUTSIDER",
      });
      const variableId = theirVar.json.id as string;
      const { siteId, environmentId } = theirs;

      const attempts: [Handler, string, Record<string, string>, unknown?][] = [
        [siteRoute.GET, "GET", { siteId }],
        [siteRoute.PATCH, "PATCH", { siteId }, { name: "Mine now" }],
        [siteRoute.DELETE, "DELETE", { siteId }],
        [siteEnvironmentsRoute.GET, "GET", { siteId }],
        [siteEnvironmentsRoute.POST, "POST", { siteId }, { name: "Prod", baseUrl: "https://example.com" }],
        [environmentRoute.GET, "GET", { environmentId }],
        [environmentRoute.PATCH, "PATCH", { environmentId }, { name: "x" }],
        [environmentRoute.DELETE, "DELETE", { environmentId }],
        [variablesRoute.GET, "GET", { environmentId }],
        [variablesRoute.POST, "POST", { environmentId }, { key: "K", value: "v" }],
        [variableRoute.GET, "GET", { variableId }],
        [variableRoute.PATCH, "PATCH", { variableId }, { isSecret: false, value: "x" }],
        [variableRoute.DELETE, "DELETE", { variableId }],
      ];
      for (const [handler, method, params, body] of attempts) {
        const res = await call(handler, { method, params, body: body ?? (method === "GET" ? undefined : {}), as: "ADMIN" });
        expect(res.status, `${method} ${JSON.stringify(params)}`).toBe(404);
        expect(res.json).toEqual({ error: { code: "not_found", message: "Not found" } });
      }
      // Nothing changed on their side.
      const row = await getDb().variable.findUniqueOrThrow({ where: { id: variableId } });
      expect(row.isSecret).toBe(true);
      expect((await getDb().site.findUniqueOrThrow({ where: { id: siteId } })).name).not.toBe("Mine now");
    });
  });

  describe("viewer", () => {
    it("is refused every write with 403", async () => {
      const { siteId, environmentId } = await setup();
      const v = await call(variablesRoute.POST, { method: "POST", params: { environmentId }, body: { key: "K", value: "v" } });
      const attempts: [Handler, string, Record<string, string>, unknown][] = [
        [workspaceRoute.PATCH, "PATCH", {}, { name: "x" }],
        [workspaceRoute.DELETE, "DELETE", {}, { confirmName: ctx.workspace.name }],
        [sitesRoute.POST, "POST", {}, { name: "x" }],
        [siteRoute.PATCH, "PATCH", { siteId }, { name: "x" }],
        [siteRoute.DELETE, "DELETE", { siteId }, {}],
        [siteEnvironmentsRoute.POST, "POST", { siteId }, { name: "x", baseUrl: "https://example.com" }],
        [environmentRoute.PATCH, "PATCH", { environmentId }, { name: "x" }],
        [environmentRoute.DELETE, "DELETE", { environmentId }, {}],
        [variablesRoute.POST, "POST", { environmentId }, { key: "X", value: "v" }],
        [variableRoute.PATCH, "PATCH", { variableId: v.json.id }, { value: "x" }],
        [variableRoute.DELETE, "DELETE", { variableId: v.json.id }, {}],
      ];
      for (const [handler, method, params, body] of attempts) {
        expect((await call(handler, { method, params, body, as: "VIEWER" })).status, `${method} ${JSON.stringify(params)}`).toBe(403);
      }
    });
  });

  describe("workspace general settings", () => {
    it("lets an admin rename; editors are refused", async () => {
      expect((await call(workspaceRoute.PATCH, { method: "PATCH", body: { name: "Renamed" }, as: "EDITOR" })).status).toBe(403);
      const res = await call(workspaceRoute.PATCH, { method: "PATCH", body: { name: "  Renamed  " }, as: "ADMIN" });
      expect(res.json).toEqual({ id: ctx.workspace.id, name: "Renamed", slug: ctx.workspace.slug, locale: "en", timezone: "UTC" });
    });

    it("sets the message language and time zone; refuses unknown ones", async () => {
      const patch = (body: unknown, as = "ADMIN") => call(workspaceRoute.PATCH, { method: "PATCH", body, as });
      expect((await patch({ locale: "ko" }, "EDITOR")).status).toBe(403);
      expect((await patch({ locale: "ko", timezone: "Asia/Seoul" })).json).toMatchObject({ name: "Renamed", locale: "ko", timezone: "Asia/Seoul" });
      expect((await patch({ locale: "fr" })).status).toBe(400);
      expect((await patch({ timezone: "Mars/Olympus" })).status).toBe(400);
      expect((await patch({})).status).toBe(400);
      expect(await getDb().workspace.findUniqueOrThrow({ where: { id: ctx.workspace.id }, select: { locale: true, timezone: true } })).toEqual({ locale: "ko", timezone: "Asia/Seoul" });
      await patch({ locale: "en", timezone: "UTC" });
    });

    it("deletes only with the exact name typed", async () => {
      const ws = await workspaceWithRoles();
      const admin = await sessionHeaders(ws.users.ADMIN.id);
      const del = (confirmName: string) =>
        callRoute(workspaceRoute.DELETE, { method: "DELETE", params: { slug: ws.workspace.slug }, body: { confirmName }, headers: admin });
      expect((await del("wrong")).status).toBe(400);
      expect((await del(ws.workspace.name)).status).toBe(204);
      expect(await getDb().workspace.findUnique({ where: { id: ws.workspace.id } })).toBeNull();
      const log = await getDb().auditLog.findFirst({ where: { action: "workspace.delete", targetId: ws.workspace.id } });
      expect(log?.workspaceId).toBeNull();
    });

    it("deletes a workspace that still has sites, environments, variables and scenarios", async () => {
      const ws = await workspaceWithRoles();
      const admin = await sessionHeaders(ws.users.ADMIN.id);
      const db = getDb();
      const site = await db.site.create({ data: { workspaceId: ws.workspace.id, name: "Shop" } });
      const env = await db.environment.create({ data: { workspaceId: ws.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://staging.example.com" } });
      await db.variable.create({ data: { workspaceId: ws.workspace.id, environmentId: env.id, key: "K", value: "v" } });
      await db.scenario.create({ data: { workspaceId: ws.workspace.id, siteId: site.id, name: "Checkout" } });
      const res = await callRoute(workspaceRoute.DELETE, { method: "DELETE", params: { slug: ws.workspace.slug }, body: { confirmName: ws.workspace.name }, headers: admin });
      expect(res.status).toBe(204);
      expect(await db.site.count({ where: { workspaceId: ws.workspace.id } })).toBe(0);
      expect(await db.scenario.count({ where: { workspaceId: ws.workspace.id } })).toBe(0);
    });
  });
});
