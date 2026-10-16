// Run API (stage 3 contract sections 3, 4.2 and 7): creation atomicity, idempotency, limits, cancel,
// artifact download and workspace isolation. The generic 401/403/404 rules come from test/access.int.test.ts.
import { Readable } from "node:stream";
import { createDbClient, lockWorkspaceRuns } from "@defe2end/db";
import { artifactKey } from "@defe2end/shared/server";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as environmentRoute from "../app/api/w/[slug]/environments/[environmentId]/route";
import * as artifactRoute from "../app/api/w/[slug]/runs/[id]/artifacts/[artifactId]/route";
import * as cancelRoute from "../app/api/w/[slug]/runs/[id]/cancel/route";
import * as runRoute from "../app/api/w/[slug]/runs/[id]/route";
import * as runsRoute from "../app/api/w/[slug]/runs/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { getDb } from "./db";
import { getStorage } from "./storage";

async function seedScenario(workspaceId: string) {
  const db = getDb();
  const site = await db.site.create({ data: { workspaceId, name: `site-${Math.random()}` } });
  const environment = await db.environment.create({ data: { workspaceId, siteId: site.id, name: "Staging", baseUrl: "https://example.com" } });
  await db.variable.create({ data: { workspaceId, environmentId: environment.id, key: "PASSWORD", isSecret: true, valueEncrypted: null } });
  const scenario = await db.scenario.create({
    data: { workspaceId, siteId: site.id, name: "Log in", steps: [{ id: "s1", action: "goto", url: "/login" }, { id: "s2", action: "fill", selector: "#pw", value: "{{PASSWORD}}" }] },
  });
  return { site, environment, scenario };
}

describeDb("run API", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let editor: Headers;
  let seed: Awaited<ReturnType<typeof seedScenario>>;
  const minFree = process.env.MIN_FREE_DISK_MB;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    editor = await sessionHeaders(ctx.users.EDITOR.id);
    seed = await seedScenario(ctx.workspace.id);
    process.env.MIN_FREE_DISK_MB = "0";
  });
  afterEach(() => {
    process.env.MIN_FREE_DISK_MB = minFree;
  });

  const body = () => ({ scenarioId: seed.scenario.id, environmentId: seed.environment.id });
  const create = (opts: { headers?: Headers; key?: string; body?: unknown; slug?: string } = {}) => {
    const headers = new Headers(opts.headers ?? editor);
    if (opts.key) headers.set("idempotency-key", opts.key);
    return callRoute(runsRoute.POST, { method: "POST", params: { slug: opts.slug ?? ctx.workspace.slug }, headers, body: opts.body ?? body() });
  };
  const fillQueue = async (count: number) => {
    const snapshot = (await getDb().run.findFirst())?.snapshot ?? {};
    await getDb().run.createMany({ data: Array.from({ length: count }, () => ({ workspaceId: ctx.workspace.id, trigger: "manual" as const, snapshot })) });
  };

  it("creates a queued run with a snapshot holding variable keys only", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run).toMatchObject({ status: "queued", cancelRequested: false, scenarioName: "Log in", environmentName: "Staging", requestedByName: ctx.users.EDITOR.email.split("@")[0] });
    expect(run.steps.map((s: { action: string; result: unknown }) => [s.action, s.result])).toEqual([["goto", null], ["fill", null]]);
    const row = await getDb().run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.snapshot).toMatchObject({ environment: { baseUrl: "https://example.com" }, variableKeys: ["PASSWORD"] });
    const read = await callRoute(runRoute.GET, { params: { slug: ctx.workspace.slug, id: run.id }, headers: await sessionHeaders(ctx.users.VIEWER.id) });
    expect((await read.json()).id).toBe(run.id);
    const list = await callRoute(runsRoute.GET, { path: `/api/w/${ctx.workspace.slug}/runs?scenarioId=${seed.scenario.id}`, params: { slug: ctx.workspace.slug }, headers: editor });
    expect((await list.json()).runs.map((r: { id: string }) => r.id)).toEqual([run.id]);
  });

  it("idempotency: same key and request → same run; different request → 409; never blocked by the queue limit", async () => {
    const first = await create({ key: "deploy-42" });
    expect(first.status).toBe(201);
    const id = (await first.json()).id;
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => create({ key: "deploy-42" })));
    for (const res of concurrent) {
      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe(id);
    }
    const other = await seedScenario(ctx.workspace.id);
    const conflict = await create({ key: "deploy-42", body: { scenarioId: other.scenario.id, environmentId: other.environment.id } });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("idempotency_conflict");

    await fillQueue(100);
    process.env.MIN_FREE_DISK_MB = String(1024 * 1024 * 1024);
    expect((await create({ key: "deploy-42" })).status).toBe(200);
    expect(await getDb().run.count({ where: { idempotencyKey: "deploy-42" } })).toBe(1);
  });

  it("concurrent creates can't overshoot the queue limit", async () => {
    await create();
    await fillQueue(98);
    const results = await Promise.all(Array.from({ length: 6 }, () => create()));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 429, 429, 429, 429, 429]);
    expect((await results.find((r) => r.status === 429)!.json()).error.code).toBe("queue_full");
    expect(await getDb().run.count({ where: { workspaceId: ctx.workspace.id, status: "queued" } })).toBe(100);
  });

  it("refuses new runs when storage is low", async () => {
    process.env.MIN_FREE_DISK_MB = String(1024 * 1024 * 1024);
    const res = await create();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("storage_low");
  });

  it("re-checks the requester after the workspace lock: demoted while waiting → 403", async () => {
    const holder = createDbClient();
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holding = holder.$transaction(
      async (tx) => {
        await lockWorkspaceRuns(tx, ctx.workspace.id);
        locked();
        await new Promise<void>((r) => (release = r));
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const pending = create();
    await new Promise((r) => setTimeout(r, 300));
    await getDb().membership.updateMany({ where: { userId: ctx.users.EDITOR.id }, data: { role: "VIEWER" } });
    release();
    await holding;
    await holder.$disconnect();
    expect((await pending).status).toBe(403);
    expect(await getDb().run.count()).toBe(0);
  });

  it("inputs must belong to the workspace and the scenario's site", async () => {
    const outside = await seedScenario(ctx.other.id);
    expect((await create({ body: { scenarioId: outside.scenario.id, environmentId: seed.environment.id } })).status).toBe(404);
    expect((await create({ body: { scenarioId: seed.scenario.id, environmentId: outside.environment.id } })).status).toBe(404);
    const otherSite = await seedScenario(ctx.workspace.id);
    expect((await create({ body: { scenarioId: seed.scenario.id, environmentId: otherSite.environment.id } })).status).toBe(400);
  });

  it("cancel: a queued run is cancelled at once, repeating answers the same", async () => {
    const run = await (await create()).json();
    const params = { slug: ctx.workspace.slug, id: run.id };
    const first = await callRoute(cancelRoute.POST, { method: "POST", params, headers: editor, body: {} });
    expect(await first.json()).toMatchObject({ status: "cancelled", cancelRequested: false });
    // A person's cancel records who asked, so no finish message goes out for it.
    expect((await getDb().run.findUniqueOrThrow({ where: { id: run.id } })).cancelRequestedById).toBe(ctx.users.EDITOR.id);
    const again = await callRoute(cancelRoute.POST, { method: "POST", params, headers: editor, body: {} });
    expect((await again.json()).status).toBe("cancelled");
  });

  it("a running run reports cancel requested, not cancelled", async () => {
    const run = await (await create()).json();
    await getDb().run.update({ where: { id: run.id }, data: { status: "running", claimToken: "t", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    const res = await callRoute(cancelRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug, id: run.id }, headers: editor, body: {} });
    expect(await res.json()).toMatchObject({ status: "running", cancelRequested: true });
    expect((await getDb().run.findUniqueOrThrow({ where: { id: run.id } })).cancelRequestedById).toBe(ctx.users.EDITOR.id);
    const detail = await (await callRoute(runRoute.GET, { params: { slug: ctx.workspace.slug, id: run.id }, headers: editor })).json();
    expect(detail).toMatchObject({ status: "running", cancelRequested: true });
  });

  it("an environment used by a queued or running run can't be deleted; a finished run keeps its snapshot", async () => {
    const run = await (await create()).json();
    const params = { slug: ctx.workspace.slug, environmentId: seed.environment.id };
    const refused = await callRoute(environmentRoute.DELETE, { method: "DELETE", params, headers: editor });
    expect(refused.status).toBe(409);
    await callRoute(cancelRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug, id: run.id }, headers: editor, body: {} });
    expect((await callRoute(environmentRoute.DELETE, { method: "DELETE", params, headers: editor })).status).toBe(204);
    const detail = await (await callRoute(runRoute.GET, { params: { slug: ctx.workspace.slug, id: run.id }, headers: editor })).json();
    expect(detail).toMatchObject({ status: "cancelled", environmentId: null, environmentName: "Staging" });
  });

  it("serves artifacts with fixed headers; ids of another workspace or run are 404", async () => {
    const run = await (await create()).json();
    const key = artifactKey(ctx.workspace.id, run.id, "png");
    const bytes = Buffer.from("\x89PNG fake image");
    await getStorage().put(key, Readable.from([bytes]));
    const artifact = await getDb().artifact.create({
      data: { runId: run.id, workspaceId: ctx.workspace.id, kind: "screenshot", name: "<script>", storageKey: key, contentType: "text/html", sizeBytes: bytes.length },
    });
    const params = { slug: ctx.workspace.slug, id: run.id, artifactId: artifact.id };
    const res = await callRoute(artifactRoute.GET, { params, headers: await sessionHeaders(ctx.users.VIEWER.id) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="screenshot-${artifact.id}.png"`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);

    // Another run of the same workspace, or the same ids through another workspace: 404.
    const otherRun = await (await create()).json();
    expect((await callRoute(artifactRoute.GET, { params: { ...params, id: otherRun.id }, headers: editor })).status).toBe(404);
    const outsider = await sessionHeaders(ctx.users.OUTSIDER.id);
    expect((await callRoute(artifactRoute.GET, { params: { ...params, slug: ctx.other.slug }, headers: outsider })).status).toBe(404);
    expect((await callRoute(runRoute.GET, { params: { slug: ctx.other.slug, id: run.id }, headers: outsider })).status).toBe(404);
    expect((await callRoute(cancelRoute.POST, { method: "POST", params: { slug: ctx.other.slug, id: run.id }, headers: outsider, body: {} })).status).toBe(404);
  });
});
