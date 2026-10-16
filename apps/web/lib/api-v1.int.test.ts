// Stage 5 contract sections 7 and 10 (API): bot token checks, bot-only values, idempotency keys, bounded
// waiting, the CI verdict and server-only placement — through the real route handlers.
import { lockWorkspaceRuns } from "@defe2end/db";
import { apiV1ErrorSchema, apiV1Passed, apiV1RunSchema, type ApiV1Run } from "@defe2end/shared";
import { beforeEach, expect, it } from "vitest";
import * as createRoute from "../app/api/v1/runs/route";
import * as readRoute from "../app/api/v1/runs/[id]/route";
import * as cancelRoute from "../app/api/v1/runs/[id]/cancel/route";
import * as revokeRoute from "../app/api/w/[slug]/bot-tokens/[tokenId]/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { activeWaits, deleteExpiredApiIdempotency, generateBotToken } from "./api-v1";
import { getDb } from "./db";

describeDb("/api/v1", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let env: { id: string };
  let scenarios: { id: string }[];
  let variable: { id: string };

  beforeEach(async () => {
    await resetDatabase();
    process.env.MIN_FREE_DISK_MB = "0";
    process.env.PUBLIC_URL = "https://e2e.example.com/";
    ctx = await workspaceWithRoles();
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    env = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://shop.example.com" } });
    scenarios = [];
    for (const name of ["a", "b", "c"]) scenarios.push(await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name, steps: [{ id: "s1", action: "goto", url: "/{{TOKEN}}" }] } }));
    variable = await db.variable.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, key: "TOKEN", scope: "personal" } });
  });

  async function makeToken(opts: { scopes?: string[]; workspaceId?: string; expiresAt?: Date; withValue?: boolean } = {}) {
    const { raw, tokenHash, prefix } = generateBotToken();
    const token = await getDb().botToken.create({
      data: { workspaceId: opts.workspaceId ?? ctx.workspace.id, name: "CI", tokenHash, prefix, scopes: opts.scopes ?? ["runs:create", "runs:read", "runs:cancel"], expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000), createdById: ctx.users.ADMIN.id },
    });
    if (opts.withValue !== false) await getDb().botVariableValue.create({ data: { botTokenId: token.id, variableId: variable.id, value: "bot" } });
    return { raw, id: token.id };
  }

  const auth = (raw: string, key?: string) => {
    const h = new Headers({ authorization: `Bearer ${raw}` });
    if (key !== undefined) h.set("idempotency-key", key);
    return h;
  };
  const create = (raw: string, key: string | undefined, body: unknown) => callRoute(createRoute.POST, { method: "POST", path: "/api/v1/runs", headers: auth(raw, key), body });
  const read = (raw: string, id: string, wait?: number, signal?: AbortSignal) => {
    const path = `/api/v1/runs/${id}${wait === undefined ? "" : `?wait=${wait}`}`;
    const request = new Request(`http://localhost:3000${path}`, { headers: auth(raw), signal });
    return readRoute.GET(request, { params: Promise.resolve({ id }) });
  };
  const cancel = (raw: string, id: string) => callRoute(cancelRoute.POST, { method: "POST", path: `/api/v1/runs/${id}/cancel`, headers: auth(raw), params: { id } });
  const errorCode = async (res: Response) => apiV1ErrorSchema.parse(await res.json()).error.code;

  it("checks the token: missing, unknown, revoked, expired → 401; scope → 403; another workspace → 404", async () => {
    const good = await makeToken();
    const body = { environmentId: env.id, scenarioId: scenarios[0]!.id };
    expect((await callRoute(createRoute.POST, { method: "POST", body })).status).toBe(401);
    expect(await errorCode(await create("d2e_nope", "k", body))).toBe("unauthenticated");

    const readOnly = await makeToken({ scopes: ["runs:read"] });
    const denied = await create(readOnly.raw, "k", body);
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe("forbidden");

    const res = await create(good.raw, "k", body);
    expect(res.status).toBe(201);
    const run = apiV1RunSchema.parse(await res.json());
    expect(run.url).toBe(`https://e2e.example.com/w/${ctx.workspace.slug}/runs/${run.id}`);
    expect((await cancel(readOnly.raw, run.id)).status).toBe(403);

    const outsider = await makeToken({ workspaceId: ctx.other.id, withValue: false });
    expect((await read(outsider.raw, run.id)).status).toBe(404);
    expect((await cancel(outsider.raw, run.id)).status).toBe(404);
    expect((await create(outsider.raw, "k", body)).status).toBe(404);

    const expired = await makeToken({ expiresAt: new Date(Date.now() - 1000) });
    expect((await read(expired.raw, run.id)).status).toBe(401);
    await getDb().botToken.update({ where: { id: good.id }, data: { revokedAt: new Date() } });
    expect((await read(good.raw, run.id)).status).toBe(401);
  });

  it("records lastUsedAt at most once a minute", async () => {
    const token = await makeToken();
    const run = apiV1RunSchema.parse(await (await create(token.raw, "k", { environmentId: env.id, scenarioId: scenarios[0]!.id })).json());
    const first = (await getDb().botToken.findUniqueOrThrow({ where: { id: token.id } })).lastUsedAt!;
    await read(token.raw, run.id);
    expect((await getDb().botToken.findUniqueOrThrow({ where: { id: token.id } })).lastUsedAt).toEqual(first);
  });

  it("runs with the bot's own values and session only, on the server, with the api origin", async () => {
    const token = await makeToken({ withValue: false });
    await getDb().personalVariableValue.create({ data: { variableId: variable.id, userId: ctx.users.ADMIN.id, value: "person" } });
    const missing = await create(token.raw, "k1", { environmentId: env.id, scenarioId: scenarios[0]!.id });
    expect(missing.status).toBe(409);
    const body = apiV1ErrorSchema.parse(await missing.json());
    expect(body.error).toMatchObject({ code: "variable_missing", keys: ["TOKEN"] });

    await getDb().botVariableValue.create({ data: { botTokenId: token.id, variableId: variable.id, value: "bot" } });
    await getDb().environment.update({ where: { id: env.id }, data: { useAuthSession: true } });
    expect(await errorCode(await create(token.raw, "k2", { environmentId: env.id, scenarioId: scenarios[0]!.id }))).toBe("auth_session_missing");
    await getDb().environment.update({ where: { id: env.id }, data: { useAuthSession: false } });

    // Only `server` is accepted as a location.
    expect((await create(token.raw, "k3", { environmentId: env.id, scenarioId: scenarios[0]!.id, location: "desktop" })).status).toBe(400);
    const res = await create(token.raw, "k3", { environmentId: env.id, scenarioId: scenarios[0]!.id, location: "server" });
    expect(res.status).toBe(201);
    const row = await getDb().run.findUniqueOrThrow({ where: { id: (await res.json()).id } });
    expect(row).toMatchObject({ location: "server", trigger: "api", botTokenId: token.id, requestedById: null });
  });

  it("idempotency keys: same body → first target, different body → 409, other token independent, concurrent → one", async () => {
    const token = await makeToken();
    const body = { environmentId: env.id, scenarioIds: [scenarios[0]!.id, scenarios[1]!.id] };
    const first = apiV1RunSchema.parse(await (await create(token.raw, "same", body)).json());
    expect(first).toMatchObject({ kind: "group", status: "queued" });
    expect(first.children).toHaveLength(2);
    const again = await create(token.raw, "same", { ...body, mode: "sequential" });
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(first.id);
    const conflict = await create(token.raw, "same", { environmentId: env.id, scenarioId: scenarios[0]!.id });
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("idempotency_conflict");
    expect(await errorCode(await create(token.raw, undefined, body))).toBe("invalid_request");
    expect((await create(token.raw, "x".repeat(129), body)).status).toBe(400);

    const other = await makeToken();
    const otherRes = await create(other.raw, "same", body);
    expect(otherRes.status).toBe(201);
    expect((await otherRes.json()).id).not.toBe(first.id);

    const results = await Promise.all(Array.from({ length: 5 }, () => create(token.raw, "race", { environmentId: env.id, scenarioId: scenarios[2]!.id })));
    const ids = new Set(await Promise.all(results.map(async (r) => (await r.json()).id)));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await getDb().run.count({ where: { scenarioId: scenarios[2]!.id } })).toBe(1);
  });

  it("a key is new again after 24 hours, and cleanup removes only old rows", async () => {
    const token = await makeToken();
    const body = { environmentId: env.id, scenarioId: scenarios[0]!.id };
    const first = (await (await create(token.raw, "day", body)).json()).id;
    await create(token.raw, "fresh", body);
    await getDb().apiIdempotency.updateMany({ where: { key: "day" }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    const later = await create(token.raw, "day", body);
    expect(later.status).toBe(201);
    expect((await later.json()).id).not.toBe(first);

    await getDb().apiIdempotency.updateMany({ where: { key: "day" }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect(await deleteExpiredApiIdempotency()).toBe(1);
    expect(await getDb().apiIdempotency.findMany({ select: { key: true } })).toEqual([{ key: "fresh" }]);
  });

  it("a tag request keeps the scenarios it chose the first time", async () => {
    const db = getDb();
    const token = await makeToken();
    const tag = await db.tag.create({ data: { workspaceId: ctx.workspace.id, name: "smoke" } });
    await db.scenarioTag.create({ data: { workspaceId: ctx.workspace.id, scenarioId: scenarios[0]!.id, tagId: tag.id } });
    const body = { environmentId: env.id, tag: "smoke" };
    const first = apiV1RunSchema.parse(await (await create(token.raw, "tag", body)).json());
    expect(first.children!.map((c) => c.scenarioId)).toEqual([scenarios[0]!.id]);
    await db.scenarioTag.create({ data: { workspaceId: ctx.workspace.id, scenarioId: scenarios[1]!.id, tagId: tag.id } });
    const again = apiV1RunSchema.parse(await (await create(token.raw, "tag", body)).json());
    expect(again.id).toBe(first.id);
    expect(again.children!.map((c) => c.scenarioId)).toEqual([scenarios[0]!.id]);
    expect((await create(token.raw, "none", { environmentId: env.id, tag: "missing" })).status).toBe(404);
  });

  it("wait: returns when the run ends, rejects over 60, stops on revoke, bounds concurrent waits", async () => {
    const token = await makeToken();
    const run = apiV1RunSchema.parse(await (await create(token.raw, "w", { environmentId: env.id, scenarioId: scenarios[0]!.id })).json());
    expect((await read(token.raw, run.id, 61)).status).toBe(400);

    // Prisma queries are lazy: await them so they run.
    setTimeout(async () => void (await getDb().run.update({ where: { id: run.id }, data: { status: "passed", startedAt: new Date(), finishedAt: new Date() } })), 1_200);
    const started = Date.now();
    const done = apiV1RunSchema.parse(await (await read(token.raw, run.id, 10)).json());
    expect(done.status).toBe("passed");
    expect(Date.now() - started).toBeLessThan(5_000);

    const run2 = apiV1RunSchema.parse(await (await create(token.raw, "w2", { environmentId: env.id, scenarioId: scenarios[1]!.id })).json());
    setTimeout(async () => void (await getDb().botToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } })), 1_200);
    const revoked = await read(token.raw, run2.id, 10);
    expect(revoked.status).toBe(401);

    const live = await makeToken();
    const aborts = Array.from({ length: 5 }, () => new AbortController());
    const pending = aborts.map((a) => read(live.raw, run2.id, 30, a.signal));
    await new Promise((r) => setTimeout(r, 200));
    expect(activeWaits().perToken.get(live.id)).toBe(5);
    const sixth = await read(live.raw, run2.id, 30);
    expect(sixth.status).toBe(429);
    expect(await errorCode(sixth)).toBe("too_many_waits");
    for (const a of aborts) a.abort();
    await Promise.all(pending);
    expect(activeWaits().total).toBe(0);
  }, 20_000);

  it("cancel: a queued run and a group's children end cancelled", async () => {
    const token = await makeToken();
    const run = apiV1RunSchema.parse(await (await create(token.raw, "c1", { environmentId: env.id, scenarioId: scenarios[0]!.id })).json());
    const cancelled = apiV1RunSchema.parse(await (await cancel(token.raw, run.id)).json());
    expect(cancelled.status).toBe("cancelled");
    expect(apiV1Passed(cancelled)).toBe(false);
    const group = apiV1RunSchema.parse(await (await create(token.raw, "c2", { environmentId: env.id, scenarioIds: [scenarios[1]!.id, scenarios[2]!.id] })).json());
    const after = apiV1RunSchema.parse(await (await cancel(token.raw, group.id)).json());
    expect(after.children!.every((c) => c.status === "cancelled")).toBe(true);
  });

  it("docs/ci.md flow: token → create → wait until finished → only passed passes", async () => {
    const token = await makeToken();
    const ci = async (key: string, scenarioId: string, options = {}): Promise<boolean> => {
      const created = await create(token.raw, key, { environmentId: env.id, scenarioId, options });
      expect(created.status).toBe(201);
      let run: ApiV1Run = apiV1RunSchema.parse(await created.json());
      while (!run.finishedAt) run = apiV1RunSchema.parse(await (await read(token.raw, run.id, 5)).json());
      expect(run.passed).toBe(apiV1Passed(run));
      return run.passed;
    };
    // Stand-in for the worker: finish each run shortly after it is queued.
    const finish = (status: "passed" | "failed", warningCount = 0) =>
      setTimeout(async () => {
        const queued = await getDb().run.findFirst({ where: { status: "queued" } });
        if (queued) await getDb().run.update({ where: { id: queued.id }, data: { status, warningCount, startedAt: new Date(), finishedAt: new Date() } });
      }, 1_100);
    finish("passed", 1);
    expect(await ci("ci-1", scenarios[0]!.id)).toBe(true);
    finish("failed");
    expect(await ci("ci-2", scenarios[1]!.id)).toBe(false);
    finish("passed", 1);
    expect(await ci("ci-3", scenarios[2]!.id, { failOnWarning: true })).toBe(false);
  }, 20_000);

  it("a token revoked while its request waits for the creation lock creates nothing (401)", async () => {
    const token = await makeToken();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = getDb().$transaction(async (tx) => {
      await lockWorkspaceRuns(tx, ctx.workspace.id);
      locked();
      await held;
    }, { timeout: 20_000 });
    await isLocked;
    const pending = create(token.raw, "late", { environmentId: env.id, scenarioId: scenarios[0]!.id });
    await new Promise((r) => setTimeout(r, 200));
    const revoked = await callRoute(revokeRoute.DELETE, { method: "DELETE", headers: await sessionHeaders(ctx.users.ADMIN.id), params: { slug: ctx.workspace.slug, tokenId: token.id } });
    expect(revoked.status).toBe(204);
    release();
    await holder;
    const res = await pending;
    expect(res.status).toBe(401);
    expect(await getDb().run.count()).toBe(0);
    expect(await getDb().apiIdempotency.count()).toBe(0);
  });

  it("options.failOnWarning: stored on the run, part of the key's request, and fails the verdict on warnings", async () => {
    const token = await makeToken();
    const body = { environmentId: env.id, scenarioId: scenarios[0]!.id, options: { failOnWarning: true } };
    const run = apiV1RunSchema.parse(await (await create(token.raw, "fow", body)).json());
    expect(run).toMatchObject({ failOnWarning: true, passed: false });
    expect((await getDb().run.findUniqueOrThrow({ where: { id: run.id } })).options).toEqual({ failOnWarning: true });
    expect(await errorCode(await create(token.raw, "fow", { environmentId: env.id, scenarioId: scenarios[0]!.id }))).toBe("idempotency_conflict");
    expect((await create(token.raw, "bad", { ...body, options: { retries: 2 } })).status).toBe(400);

    await getDb().run.update({ where: { id: run.id }, data: { status: "passed", warningCount: 1, startedAt: new Date(), finishedAt: new Date() } });
    const warned = apiV1RunSchema.parse(await (await read(token.raw, run.id)).json());
    expect(warned).toMatchObject({ status: "passed", warningCount: 1, failOnWarning: true, passed: false });
    expect(apiV1Passed(warned)).toBe(false);

    const plain = apiV1RunSchema.parse(await (await create(token.raw, "plain", { environmentId: env.id, scenarioId: scenarios[1]!.id })).json());
    await getDb().run.update({ where: { id: plain.id }, data: { status: "passed", warningCount: 1, startedAt: new Date(), finishedAt: new Date() } });
    expect(apiV1RunSchema.parse(await (await read(token.raw, plain.id)).json())).toMatchObject({ failOnWarning: false, passed: true });
  });
});
