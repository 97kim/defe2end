// Stage 5 contract sections 1.1, 4 and 9: schedule API — permissions, cron check and preview, edits bump
// `version` and re-plan, the environment change that deletes the schedule's values, write-only secret values.
import { beforeEach, expect, it } from "vitest";
import * as itemRoute from "../app/api/w/[slug]/schedules/[scheduleId]/route";
import * as firesRoute from "../app/api/w/[slug]/schedules/[scheduleId]/fires/route";
import * as valueRoute from "../app/api/w/[slug]/schedules/[scheduleId]/values/[variableId]/route";
import * as valuesRoute from "../app/api/w/[slug]/schedules/[scheduleId]/values/route";
import * as previewRoute from "../app/api/w/[slug]/schedules/preview/route";
import * as listRoute from "../app/api/w/[slug]/schedules/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { getDb } from "./db";

describeDb("schedule API", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let env: { id: string; siteId: string };
  let env2: { id: string };
  let scenario: { id: string };
  let editor: Headers;
  let viewer: Headers;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    const db = getDb();
    await db.workspace.update({ where: { id: ctx.workspace.id }, data: { timezone: "Asia/Seoul" } });
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    env = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://shop.example.com" } });
    env2 = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Prod", baseUrl: "https://shop.example.com" } });
    scenario = await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "a", steps: [] } });
    editor = await sessionHeaders(ctx.users.EDITOR.id);
    viewer = await sessionHeaders(ctx.users.VIEWER.id);
  });

  const slug = () => ctx.workspace.slug;
  const create = (body: Record<string, unknown>, headers = editor) =>
    callRoute(listRoute.POST, { method: "POST", params: { slug: slug() }, headers, body: { name: "Nightly", environmentId: env.id, scenarioIds: [scenario.id], cron: "0 2 * * *", ...body } });

  it("creates in the workspace time zone with the next run planned; viewers read but can't write", async () => {
    expect((await create({}, viewer)).status).toBe(403);
    const res = await create({});
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ timezone: "Asia/Seoul", enabled: true, overlap: "skip", version: 1, lastFire: null });
    // 02:00 in Seoul is 17:00 UTC.
    expect(new Date(created.nextRunAt).getUTCHours()).toBe(17);
    const list = await (await callRoute(listRoute.GET, { params: { slug: slug() }, headers: viewer })).json();
    expect(list.schedules.map((s: { id: string }) => s.id)).toEqual([created.id]);
    const audit = await getDb().auditLog.findFirst({ where: { action: "schedule.create", targetId: created.id } });
    expect(audit).not.toBeNull();
  });

  it("refuses bad cron, never-firing expressions, unknown time zones and two targets; previews five times", async () => {
    for (const cron of ["0 2 * *", "61 * * * *", "0 0 31 2 *"]) expect((await create({ cron })).status).toBe(400);
    expect((await create({ timezone: "Mars/Base" })).status).toBe(400);
    const tag = await getDb().tag.create({ data: { workspaceId: ctx.workspace.id, name: "smoke" } });
    expect((await create({ tagId: tag.id })).status).toBe(400);
    expect((await create({ scenarioIds: [], tagId: tag.id })).status).toBe(201);
    const foreign = await getDb().environment.create({ data: { workspaceId: ctx.other.id, siteId: (await getDb().site.create({ data: { workspaceId: ctx.other.id, name: "x" } })).id, name: "x", baseUrl: "https://x" } });
    expect((await create({ environmentId: foreign.id })).status).toBe(404);

    const preview = (cron: string, timezone = "UTC") => callRoute(previewRoute.GET, { path: `/?${new URLSearchParams({ cron, timezone })}`, params: { slug: slug() }, headers: viewer }).then((r) => r.json());
    const ok = await preview("*/15 * * * *");
    expect(ok.ok).toBe(true);
    expect(ok.times).toHaveLength(5);
    expect(await preview("0 0 31 2 *")).toMatchObject({ ok: false, code: "cron_never" });
  });

  it("edits bump version and re-plan; turning off clears nextRunAt; changing the environment needs confirmation and deletes values", async () => {
    const db = getDb();
    const created = await (await create({})).json();
    const patch = (body: unknown, headers = editor) => callRoute(itemRoute.PATCH, { method: "PATCH", params: { slug: slug(), scheduleId: created.id }, headers, body });
    expect((await patch({ enabled: false }, viewer)).status).toBe(403);
    const off = await (await patch({ enabled: false })).json();
    expect(off).toMatchObject({ enabled: false, nextRunAt: null, version: 2 });
    const on = await (await patch({ enabled: true, cron: "30 * * * *", timezone: "UTC" })).json();
    expect(on.version).toBe(3);
    expect(new Date(on.nextRunAt).getUTCMinutes()).toBe(30);

    const secret = await db.variable.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, key: "PW", scope: "personal", isSecret: true } });
    const plain = await db.variable.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, key: "USER", scope: "personal" } });
    const shared = await db.variable.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, key: "HOST", scope: "shared", value: "h" } });
    const put = (variableId: string, value: string, headers = editor) => callRoute(valueRoute.PUT, { method: "PUT", params: { slug: slug(), scheduleId: created.id, variableId }, headers, body: { value } });
    expect((await put(secret.id, "hunter2", viewer)).status).toBe(403);
    expect((await put(secret.id, "hunter2")).status).toBe(204);
    expect((await put(plain.id, "bot")).status).toBe(204);
    expect((await put(shared.id, "x")).status).toBe(409);
    const values = await (await callRoute(valuesRoute.GET, { params: { slug: slug(), scheduleId: created.id }, headers: viewer })).json();
    expect(values.variables).toEqual([
      { id: secret.id, key: "PW", isSecret: true, hasValue: true },
      { id: plain.id, key: "USER", isSecret: false, hasValue: true, value: "bot" },
    ]);
    expect(JSON.stringify(values)).not.toContain("hunter2");
    expect(values.authSession).toMatchObject({ required: false });
    const audits = await db.auditLog.findMany({ where: { action: "schedule.value.set" } });
    expect(JSON.stringify(audits)).not.toContain("hunter2");

    const moved = await patch({ environmentId: env2.id });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ error: { code: "conflict", reason: "values_reset_required", values: 2 } });
    expect((await patch({ environmentId: env2.id, confirmValueReset: true })).status).toBe(200);
    expect(await db.scheduleVariableValue.count()).toBe(0);

    const fires = await (await callRoute(firesRoute.GET, { params: { slug: slug(), scheduleId: created.id }, headers: viewer })).json();
    expect(fires.fires).toEqual([]);
    expect((await callRoute(itemRoute.DELETE, { method: "DELETE", params: { slug: slug(), scheduleId: created.id }, headers: viewer })).status).toBe(403);
    expect((await callRoute(itemRoute.DELETE, { method: "DELETE", params: { slug: slug(), scheduleId: created.id }, headers: editor })).status).toBe(204);
    expect(await db.schedule.count()).toBe(0);
  });

  it("another workspace's schedule is 404", async () => {
    const created = await (await create({})).json();
    const outsider = await sessionHeaders(ctx.users.OUTSIDER.id);
    const res = await callRoute(itemRoute.GET, { params: { slug: ctx.other.slug, scheduleId: created.id }, headers: outsider });
    expect(res.status).toBe(404);
  });
});
