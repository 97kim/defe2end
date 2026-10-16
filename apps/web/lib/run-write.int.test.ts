// Run write APIs beyond single runs (stage 3 contract sections 3, 4.2, 4.4 and 7): groups (all-or-nothing under
// the queue limit), test runs, re-run failed, stop-all and attachment uploads with their limits under concurrency.
import { afterEach, beforeEach, expect, it } from "vitest";
import * as attachmentRoute from "../app/api/w/[slug]/attachments/[attachmentId]/route";
import * as uploadRoute from "../app/api/w/[slug]/attachments/upload/route";
import * as rerunRoute from "../app/api/w/[slug]/groups/[groupId]/rerun-failed/route";
import * as groupsRoute from "../app/api/w/[slug]/groups/route";
import * as runsRoute from "../app/api/w/[slug]/runs/route";
import * as stopAllRoute from "../app/api/w/[slug]/runs/stop-all/route";
import * as testRunRoute from "../app/api/w/[slug]/runs/test/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { getDb } from "./db";
import { getStorage } from "./storage";

const ENV_KEYS = ["MIN_FREE_DISK_MB", "ATTACHMENT_MAX_MB", "ATTACHMENT_WORKSPACE_MAX_MB"] as const;

describeDb("run write APIs", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let editor: Headers;
  let site: { id: string };
  let environment: { id: string };
  let scenarios: { id: string }[];
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeEach(async () => {
    await resetDatabase();
    process.env.MIN_FREE_DISK_MB = "0";
    ctx = await workspaceWithRoles();
    editor = await sessionHeaders(ctx.users.EDITOR.id);
    const db = getDb();
    site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    environment = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://example.com" } });
    scenarios = [];
    for (const name of ["a", "b", "c"]) {
      scenarios.push(await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name, steps: [{ id: "s1", action: "goto", url: `/${name}` }] } }));
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const slug = () => ctx.workspace.slug;
  const post = (handler: Parameters<typeof callRoute>[0], body: unknown, opts: { headers?: Headers; key?: string; params?: Record<string, string> } = {}) => {
    const headers = new Headers(opts.headers ?? editor);
    if (opts.key) headers.set("idempotency-key", opts.key);
    return callRoute(handler, { method: "POST", params: { slug: slug(), ...opts.params }, headers, body });
  };
  const groupBody = (over: Record<string, unknown> = {}) => ({
    environmentId: environment.id,
    scenarioIds: scenarios.map((s) => s.id),
    mode: "sequential",
    continueOnFailure: false,
    ...over,
  });
  const fillQueue = async (count: number) => {
    await getDb().run.createMany({ data: Array.from({ length: count }, () => ({ workspaceId: ctx.workspace.id, trigger: "manual" as const, snapshot: {} })) });
  };

  it("creates a group with every child in order, snapshots fixed", async () => {
    const res = await post(groupsRoute.POST, groupBody());
    expect(res.status).toBe(201);
    const { id, runIds } = await res.json();
    const group = await getDb().groupRun.findUniqueOrThrow({ where: { id }, include: { runs: { orderBy: { groupIndex: "asc" } } } });
    expect(group).toMatchObject({ status: "queued", mode: "sequential", continueOnFailure: false, environmentId: environment.id, requestedById: ctx.users.EDITOR.id });
    expect(group.runs.map((r) => [r.id, r.groupIndex, r.scenarioId, (r.snapshot as { scenario: { name: string } }).scenario.name])).toEqual([
      [runIds[0], 0, scenarios[0]!.id, "a"],
      [runIds[1], 1, scenarios[1]!.id, "b"],
      [runIds[2], 2, scenarios[2]!.id, "c"],
    ]);
  });

  it("a group over the queue limit is refused whole; concurrent groups never pass the limit together", async () => {
    await fillQueue(98);
    const refused = await post(groupsRoute.POST, groupBody());
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.code).toBe("queue_full");
    expect(await getDb().groupRun.count()).toBe(0);
    expect(await getDb().run.count()).toBe(98);

    await getDb().run.deleteMany({});
    await fillQueue(91);
    // Room for 9: three groups of 3 fit, the fourth doesn't — whichever commits last.
    const results = await Promise.all(Array.from({ length: 4 }, () => post(groupsRoute.POST, groupBody())));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 429]);
    expect(await getDb().run.count({ where: { status: "queued" } })).toBe(100);
    expect(await getDb().groupRun.count()).toBe(3);
  });

  it("concurrent single creates stop exactly at the queue limit", async () => {
    await fillQueue(95);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post(runsRoute.POST, { scenarioId: scenarios[0]!.id, environmentId: environment.id })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
    expect(await getDb().run.count({ where: { status: "queued" } })).toBe(100);
  });

  it("refuses groups that mix sites or workspaces, creating nothing", async () => {
    const otherSite = await getDb().site.create({ data: { workspaceId: ctx.workspace.id, name: "Blog" } });
    const stray = await getDb().scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: otherSite.id, name: "x", steps: [] } });
    expect((await post(groupsRoute.POST, groupBody({ scenarioIds: [scenarios[0]!.id, stray.id] }))).status).toBe(400);
    const otherWs = await getDb().site.create({ data: { workspaceId: ctx.other.id, name: "Other" } });
    const foreign = await getDb().scenario.create({ data: { workspaceId: ctx.other.id, siteId: otherWs.id, name: "y", steps: [] } });
    expect((await post(groupsRoute.POST, groupBody({ scenarioIds: [scenarios[0]!.id, foreign.id] }))).status).toBe(404);
    expect(await getDb().run.count()).toBe(0);
    expect(await getDb().groupRun.count()).toBe(0);
  });

  it("a group's idempotency key returns the same group; storage_low refuses new groups", async () => {
    const first = await post(groupsRoute.POST, groupBody(), { key: "nightly-1" });
    const again = await post(groupsRoute.POST, groupBody(), { key: "nightly-1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    expect((await post(groupsRoute.POST, groupBody({ mode: "parallel" }), { key: "nightly-1" })).status).toBe(409);

    process.env.MIN_FREE_DISK_MB = String(Number.MAX_SAFE_INTEGER / 1024 / 1024);
    const low = await post(groupsRoute.POST, groupBody());
    expect(low.status).toBe(503);
    expect((await low.json()).error.code).toBe("storage_low");
    // A repeated key is answered without the limits.
    expect((await post(groupsRoute.POST, groupBody(), { key: "nightly-1" })).status).toBe(200);
  });

  it("a test run carries the body's steps, no scenario, and validates them", async () => {
    const steps = [{ id: "t1", action: "goto", url: "/draft" }];
    const res = await post(testRunRoute.POST, { environmentId: environment.id, steps });
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run).toMatchObject({ trigger: "test", scenarioId: null, scenarioName: "Test run", status: "queued" });
    const row = await getDb().run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.snapshot).toMatchObject({ scenario: { id: null, steps }, environment: { id: environment.id } });

    expect((await post(testRunRoute.POST, { environmentId: environment.id, steps: [{ id: "t1", action: "teleport" }] })).status).toBe(400);
    expect((await post(testRunRoute.POST, { environmentId: environment.id, steps }, { headers: await sessionHeaders(ctx.users.VIEWER.id) })).status).toBe(403);
  });

  it("re-run failed: a new group of the failed, error and timed-out children; the old one unchanged", async () => {
    const { id } = await (await post(groupsRoute.POST, groupBody({ scenarioIds: [scenarios[0]!.id, scenarios[1]!.id, scenarios[2]!.id, scenarios[0]!.id] }))).json();
    const params = { groupId: id };
    expect((await post(rerunRoute.POST, undefined, { params })).status).toBe(409); // still queued

    const children = await getDb().run.findMany({ where: { groupRunId: id }, orderBy: { groupIndex: "asc" } });
    const statuses = ["failed", "passed", "error", "timed_out"] as const;
    for (const [i, child] of children.entries()) await getDb().run.update({ where: { id: child.id }, data: { status: statuses[i], finishedAt: new Date() } });
    await getDb().groupRun.update({ where: { id }, data: { status: "error", finishedAt: new Date() } });

    const res = await post(rerunRoute.POST, undefined, { params });
    expect(res.status).toBe(201);
    const rerun = await res.json();
    const group = await getDb().groupRun.findUniqueOrThrow({ where: { id: rerun.id }, include: { runs: { orderBy: { groupIndex: "asc" } } } });
    expect(group.runs.map((r) => r.scenarioId)).toEqual([scenarios[0]!.id, scenarios[2]!.id, scenarios[0]!.id]);
    expect(group).toMatchObject({ mode: "sequential", continueOnFailure: false, status: "queued" });
    expect((await getDb().run.findMany({ where: { groupRunId: id }, orderBy: { groupIndex: "asc" } })).map((r) => r.status)).toEqual([...statuses]);

    const otherGroup = await getDb().groupRun.create({ data: { workspaceId: ctx.other.id, mode: "parallel", continueOnFailure: true, status: "failed" } });
    expect((await post(rerunRoute.POST, undefined, { params: { groupId: otherGroup.id } })).status).toBe(404);
  });

  it("stop-all (admins only) takes the runs present when it commits", async () => {
    const make = async () => (await (await post(runsRoute.POST, { scenarioId: scenarios[0]!.id, environmentId: environment.id })).json()).id as string;
    const queued = await make();
    const running = await make();
    await getDb().run.update({ where: { id: running }, data: { status: "running", claimToken: "t", leaseExpiresAt: new Date(Date.now() + 60_000), startedAt: new Date() } });
    const done = await make();
    await getDb().run.update({ where: { id: done }, data: { status: "passed", finishedAt: new Date() } });
    const elsewhere = await getDb().run.create({ data: { workspaceId: ctx.other.id, trigger: "manual", snapshot: {} } });

    expect((await post(stopAllRoute.POST, {})).status).toBe(403);
    const res = await post(stopAllRoute.POST, {}, { headers: await sessionHeaders(ctx.users.ADMIN.id) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: 1, cancelRequested: 1 });
    const after = await make();

    const read = (id: string) => getDb().run.findUniqueOrThrow({ where: { id } });
    expect((await read(queued)).status).toBe("cancelled");
    expect(await read(running)).toMatchObject({ status: "running", cancelRequestedAt: expect.any(Date), cancelRequestedById: ctx.users.ADMIN.id });
    expect((await read(queued)).cancelRequestedById).toBe(ctx.users.ADMIN.id);
    expect((await read(done)).status).toBe("passed");
    expect((await read(elsewhere.id)).status).toBe("queued");
    expect(await read(after)).toMatchObject({ status: "queued", cancelRequestedAt: null });
  });

  describe_uploads();

  function describe_uploads() {
    const upload = async (bytes: number, name = "photo.png", headers = editor) => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(bytes).fill(7)], "local-name.png", { type: "image/png" }));
      form.set("name", name);
      const body = new Request("http://x", { method: "POST", body: form });
      const raw = await body.arrayBuffer();
      const h = new Headers(headers);
      h.set("content-type", body.headers.get("content-type")!);
      h.set("content-length", String(raw.byteLength));
      return uploadRoute.POST(new Request(`http://localhost:3000/api/w/${slug()}/attachments/upload`, { method: "POST", headers: h, body: raw }), {
        params: Promise.resolve({ slug: slug() }),
      });
    };
    const storedFiles = async () => {
      const files = [];
      for await (const f of getStorage().list(`workspaces/${ctx.workspace.id}/attachments/`)) files.push(f.key);
      return files;
    };

    it("uploads versions under a server-made key", async () => {
      const first = await upload(1000);
      expect(first.status).toBe(201);
      expect(await first.json()).toMatchObject({ name: "photo.png", version: 1, contentType: "image/png", sizeBytes: 1000 });
      expect((await (await upload(10)).json()).version).toBe(2);
      const rows = await getDb().attachment.findMany({ where: { workspaceId: ctx.workspace.id } });
      expect(rows.every((r) => r.storageKey.startsWith(`workspaces/${ctx.workspace.id}/attachments/`) && !r.storageKey.includes("photo"))).toBe(true);
      expect((await storedFiles()).sort()).toEqual(rows.map((r) => r.storageKey).sort());
      expect((await upload(10, "../etc/passwd")).status).toBe(400);
    });

    it("413 over the file limit, leaving no file", async () => {
      process.env.ATTACHMENT_MAX_MB = "1";
      const res = await upload(1024 * 1024 + 1);
      expect(res.status).toBe(413);
      expect((await res.json()).error.code).toBe("payload_too_large");
      expect(await getDb().attachment.count()).toBe(0);
      expect(await storedFiles()).toEqual([]);
    });

    it("concurrent uploads never pass the workspace total together; refused files are deleted", async () => {
      process.env.ATTACHMENT_WORKSPACE_MAX_MB = "2";
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => upload(900 * 1024, `f${i}`)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 413, 413]);
      const rows = await getDb().attachment.findMany({ where: { workspaceId: ctx.workspace.id } });
      expect(rows).toHaveLength(2);
      expect((await storedFiles()).sort()).toEqual(rows.map((r) => r.storageKey).sort());
    });

    const uploadStep = (value: string) => [{ id: "s1", action: "uploadFile", selector: "#file", value }];
    const snapshotOf = async (runId: string) => ((await getDb().run.findUniqueOrThrow({ where: { id: runId } })).snapshot as { attachments: unknown[] }).attachments;

    it("pins referenced attachments at their current version for scenario and test runs", async () => {
      await upload(10, "my photo.png");
      const v2 = await (await upload(20, "my photo.png")).json();
      await upload(5, "unused.png");
      await getDb().scenario.update({ where: { id: scenarios[0]!.id }, data: { steps: uploadStep("attachment:my%20photo.png https://x.test/a.png") } });
      const run = await post(runsRoute.POST, { scenarioId: scenarios[0]!.id, environmentId: environment.id });
      expect(run.status).toBe(201);
      const runId = (await run.json()).id;
      expect(await snapshotOf(runId)).toEqual([{ name: "my photo.png", id: v2.id, version: 2 }]);
      const test = await post(testRunRoute.POST, { environmentId: environment.id, steps: uploadStep("attachment:my%20photo.png") });
      expect(test.status).toBe(201);
      expect(await snapshotOf((await test.json()).id)).toEqual([{ name: "my photo.png", id: v2.id, version: 2 }]);
      // A newer version uploaded afterwards doesn't change what was pinned.
      await upload(30, "my photo.png");
      expect(await snapshotOf(runId)).toEqual([{ name: "my photo.png", id: v2.id, version: 2 }]);
    });

    it("400 naming the step when a referenced attachment doesn't exist in this workspace", async () => {
      await getDb().attachment.create({ data: { workspaceId: ctx.other.id, name: "theirs.png", version: 1, storageKey: "x/theirs", contentType: "image/png", sizeBytes: 1 } });
      const res = await post(testRunRoute.POST, { environmentId: environment.id, steps: [{ id: "s0", action: "goto", url: "/" }, ...uploadStep("attachment:theirs.png")] });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain('Step 2: no workspace attachment named "theirs.png"');
      expect((await post(testRunRoute.POST, { environmentId: environment.id, steps: uploadStep("attachment:{{FILE}}") })).status).toBe(400);
      expect(await getDb().run.count()).toBe(0);
    });

    it("refuses to delete a pinned version while its run is queued or running (409)", async () => {
      const v1 = await (await upload(10, "doc.pdf")).json();
      const free = await (await upload(10, "other.pdf")).json();
      const res = await post(testRunRoute.POST, { environmentId: environment.id, steps: uploadStep("attachment:doc.pdf") });
      const { id: runId } = await res.json();
      const del = (attachmentId: string) => callRoute(attachmentRoute.DELETE, { method: "DELETE", params: { slug: slug(), attachmentId }, headers: editor });
      expect((await del(v1.id)).status).toBe(409);
      expect((await del(free.id)).status).toBe(204);
      await getDb().run.update({ where: { id: runId }, data: { status: "running" } });
      expect((await del(v1.id)).status).toBe(409);
      await getDb().run.update({ where: { id: runId }, data: { status: "passed" } });
      expect((await del(v1.id)).status).toBe(204);
    });
  }
});
