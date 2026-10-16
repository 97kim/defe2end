import { beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, createUser, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { ApiError, readJson, route } from "./api";
import { getDb } from "./db";

const write = route({ action: "config.write", resource: "site" }, async ({ request, workspace, actor }) => {
  const body = await readJson(request, z.object({ name: z.string().min(1) }));
  if (body.name === "taken") throw new ApiError("conflict", "Name taken");
  return Response.json({ workspaceId: workspace.id, by: actor.userId, name: body.name });
});
// The pattern for ids in the URL: always scope the lookup by the checked workspace.
const readSite = route<{ slug: string; id: string }>({ action: "workspace.read", resource: "site" }, async ({ params, workspace }) => {
  const site = await getDb().site.findFirst({ where: { id: params.id, workspaceId: workspace.id } });
  if (!site) throw ApiError.notFound();
  return Response.json({ name: site.name });
});
const instance = route({ action: "workspace.create", resource: "instance" }, () => Response.json({ ok: true }));

describeDb("route()", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
  });

  const call = async (userId: string | undefined, body: unknown = { name: "Shop" }, slug = ctx.workspace.slug) =>
    callRoute(write, { method: "POST", params: { slug }, body, headers: userId ? await sessionHeaders(userId) : undefined });

  it("runs the handler for an allowed role", async () => {
    const res = await call(ctx.users.EDITOR.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: ctx.workspace.id, by: ctx.users.EDITOR.id, name: "Shop" });
  });

  it("maps signed out, non-member and low role to 401/404/403", async () => {
    expect((await call(undefined)).status).toBe(401);
    expect((await call(ctx.users.OUTSIDER.id)).status).toBe(404);
    expect((await call(ctx.users.VIEWER.id)).status).toBe(403);
  });

  it("does not let an instance admin bypass membership", async () => {
    const admin = await createUser({ isInstanceAdmin: true });
    expect((await call(admin.id)).status).toBe(404);
  });

  it("maps validation and ApiError to the error format", async () => {
    const bad = await call(ctx.users.ADMIN.id, { name: "" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_request");
    const conflict = await call(ctx.users.ADMIN.id, { name: "taken" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "conflict", message: "Name taken" } });
  });

  it("answers 404 for an id from another workspace, same body as a non-member", async () => {
    const mine = await getDb().site.create({ data: { workspaceId: ctx.workspace.id, name: "Mine" } });
    const theirs = await getDb().site.create({ data: { workspaceId: ctx.other.id, name: "Theirs" } });
    const get = async (id: string) =>
      callRoute(readSite, { params: { slug: ctx.workspace.slug, id }, headers: await sessionHeaders(ctx.users.VIEWER.id) });
    expect(await (await get(mine.id)).json()).toEqual({ name: "Mine" });
    const res = await get(theirs.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("treats a disabled user as signed out", async () => {
    const user = await createUser();
    const headers = await sessionHeaders(user.id);
    await getDb().user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
    expect((await callRoute(write, { method: "POST", params: { slug: ctx.workspace.slug }, body: { name: "x" }, headers })).status).toBe(401);
  });

  it("checks instance actions with isInstanceAdmin", async () => {
    const admin = await createUser({ isInstanceAdmin: true });
    expect((await callRoute(instance, { headers: await sessionHeaders(admin.id) })).status).toBe(200);
    expect((await callRoute(instance, { headers: await sessionHeaders(ctx.users.ADMIN.id) })).status).toBe(403);
  });

  it("rejects an action that doesn't fit the resource", () => {
    expect(() => route({ action: "workspace.create", resource: "site" } as never, () => new Response())).toThrow();
  });
});
