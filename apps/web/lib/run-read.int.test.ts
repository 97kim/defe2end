// Read side of runs (stage 3 contract section 7): list filters and pages, live events (SSE), group and attachment
// reads, workspace isolation. Generic 401/403/404 per route come from test/access.int.test.ts.
import { Readable } from "node:stream";
import type { Prisma } from "@defe2end/db";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as attachmentRoute from "../app/api/w/[slug]/attachments/[attachmentId]/route";
import * as attachmentsRoute from "../app/api/w/[slug]/attachments/route";
import * as groupRoute from "../app/api/w/[slug]/groups/[groupId]/route";
import * as artifactRoute from "../app/api/w/[slug]/runs/[id]/artifacts/[artifactId]/route";
import * as eventsRoute from "../app/api/w/[slug]/runs/[id]/events/route";
import * as runRoute from "../app/api/w/[slug]/runs/[id]/route";
import * as runsRoute from "../app/api/w/[slug]/runs/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { getDb } from "./db";
import { getRunChanges } from "./run-read";
import { getStorage } from "./storage";

type Ctx = Awaited<ReturnType<typeof workspaceWithRoles>>;

async function seed(workspaceId: string) {
  const db = getDb();
  const site = await db.site.create({ data: { workspaceId, name: `site-${Math.random()}` } });
  const staging = await db.environment.create({ data: { workspaceId, siteId: site.id, name: "Staging", baseUrl: "https://staging.example.com" } });
  const prod = await db.environment.create({ data: { workspaceId, siteId: site.id, name: "Production", baseUrl: "https://example.com" } });
  const steps = [
    { id: "s1", action: "goto", url: "/" },
    { id: "s2", action: "click", selector: "#buy", timeout: 5000 },
  ];
  const scenario = await db.scenario.create({ data: { workspaceId, siteId: site.id, name: "Checkout", steps } });
  return { site, staging, prod, scenario, steps };
}

type Seed = Awaited<ReturnType<typeof seed>>;

let clock = Date.parse("2026-10-01T00:00:00Z");

/** A run row as the worker would leave it; `durations` adds step results. */
async function makeRun(
  ws: string,
  s: Seed,
  opts: { env?: "staging" | "prod"; status?: Prisma.RunCreateInput["status"]; trigger?: "manual" | "schedule"; durations?: number[]; stepStatus?: ("passed" | "failed")[]; runnerVersion?: string } = {},
) {
  const env = opts.env === "prod" ? s.prod : s.staging;
  const queuedAt = new Date((clock += 60_000));
  const finished = opts.status && opts.status !== "queued" && opts.status !== "running";
  const run = await getDb().run.create({
    data: {
      workspaceId: ws,
      scenarioId: s.scenario.id,
      environmentId: env.id,
      trigger: opts.trigger ?? "manual",
      status: opts.status ?? "queued",
      snapshot: {
        scenario: { id: s.scenario.id, name: "Checkout", stepFormatVersion: 1, steps: s.steps },
        environment: { id: env.id, name: env.name, baseUrl: env.baseUrl },
        device: { viewport: { width: 1280, height: 720 } },
        attachments: [],
        variableKeys: [],
      },
      queuedAt,
      startedAt: opts.status && opts.status !== "queued" ? new Date(queuedAt.getTime() + 1000) : null,
      finishedAt: finished ? new Date(queuedAt.getTime() + 5000) : null,
      runnerVersion: opts.runnerVersion ?? "0.1.0",
    },
  });
  for (const [index, durationMs] of (opts.durations ?? []).entries()) {
    await getDb().stepResult.create({
      data: { runId: run.id, index, stepId: s.steps[index]!.id, action: s.steps[index]!.action, status: opts.stepStatus?.[index] ?? "passed", attempts: 1, startedAt: queuedAt, durationMs },
    });
  }
  return run;
}

/** Reads SSE events until `until` matches one, the stream ends or time runs out. */
async function readEvents(res: Response, until: (e: { type: string; [k: string]: unknown }) => boolean, timeoutMs = 6000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: { type: string; [k: string]: unknown }[] = [];
  let buffer = "";
  let ended = false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now()))]);
    if (chunk === null) break;
    if (chunk.done) {
      ended = true;
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
    if (events.some(until)) break;
  }
  return { events, ended, reader };
}

describeDb("run read API", () => {
  let ctx: Ctx;
  let s: Seed;
  let viewer: Headers;
  const opened: ReadableStreamDefaultReader<Uint8Array>[] = [];

  beforeEach(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    s = await seed(ctx.workspace.id);
    viewer = await sessionHeaders(ctx.users.VIEWER.id);
  });
  afterEach(async () => {
    // Close streams a test left open so their polling stops.
    await Promise.all(opened.splice(0).map((r) => r.cancel().catch(() => {})));
  });

  const slug = () => ctx.workspace.slug;
  const events = async (id: string, headers: Headers, s2 = slug()) => {
    const res = await callRoute(eventsRoute.GET, { params: { slug: s2, id }, headers });
    return res;
  };

  it("lists newest first with filters and pages; viewers can read", async () => {
    const a = await makeRun(ctx.workspace.id, s, { status: "passed" });
    const b = await makeRun(ctx.workspace.id, s, { status: "failed", env: "prod" });
    const c = await makeRun(ctx.workspace.id, s, { status: "passed", trigger: "schedule" });
    const list = async (q: string) => {
      const res = await callRoute(runsRoute.GET, { path: `/api/w/${slug()}/runs?${q}`, params: { slug: slug() }, headers: viewer });
      expect(res.status).toBe(200);
      return (await res.json()) as { runs: { id: string }[]; total: number; page: number };
    };
    expect((await list("")).runs.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect((await list("status=passed")).runs.map((r) => r.id)).toEqual([c.id, a.id]);
    expect((await list(`environmentId=${s.prod.id}`)).runs.map((r) => r.id)).toEqual([b.id]);
    expect((await list("trigger=schedule")).runs.map((r) => r.id)).toEqual([c.id]);
    expect((await list(`scenarioId=${s.scenario.id}&status=`)).total).toBe(3);
    const page2 = await list("limit=2&page=2");
    expect(page2).toMatchObject({ total: 3, page: 2 });
    expect(page2.runs.map((r) => r.id)).toEqual([a.id]);
    const bad = await callRoute(runsRoute.GET, { path: `/api/w/${slug()}/runs?status=nope`, params: { slug: slug() }, headers: viewer });
    expect(bad.status).toBe(400);
  });

  it("another workspace's run, events, artifact, group and attachment ids are 404", async () => {
    const run = await makeRun(ctx.workspace.id, s, { status: "passed" });
    const key = `workspaces/${ctx.workspace.id}/runs/${run.id}/shot.png`.toLowerCase();
    await getStorage().put(key, Readable.from([Buffer.from("png")]));
    const artifact = await getDb().artifact.create({ data: { runId: run.id, workspaceId: ctx.workspace.id, kind: "screenshot", name: "home", storageKey: key, contentType: "image/png", sizeBytes: 3 } });
    const group = await getDb().groupRun.create({ data: { workspaceId: ctx.workspace.id, mode: "sequential", continueOnFailure: false } });
    const attKey = `workspaces/${ctx.workspace.id}/attachments/${Date.now()}.bin`;
    await getStorage().put(attKey, Readable.from([Buffer.from("<html>")]));
    const attachment = await getDb().attachment.create({ data: { workspaceId: ctx.workspace.id, name: "page.html", version: 1, storageKey: attKey, contentType: "text/html", sizeBytes: 6 } });

    // The outsider is an admin of the other workspace and asks through that workspace's slug.
    const outsider = await sessionHeaders(ctx.users.OUTSIDER.id);
    const other = ctx.other.slug;
    const calls = [
      callRoute(runRoute.GET, { params: { slug: other, id: run.id }, headers: outsider }),
      callRoute(eventsRoute.GET, { params: { slug: other, id: run.id }, headers: outsider }),
      callRoute(artifactRoute.GET, { params: { slug: other, id: run.id, artifactId: artifact.id }, headers: outsider }),
      callRoute(groupRoute.GET, { params: { slug: other, groupId: group.id }, headers: outsider }),
      callRoute(attachmentRoute.GET, { params: { slug: other, attachmentId: attachment.id }, headers: outsider }),
      callRoute(attachmentRoute.DELETE, { method: "DELETE", params: { slug: other, attachmentId: attachment.id }, headers: outsider }),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(404);

    // The same ids work for a viewer of the right workspace.
    expect((await callRoute(runRoute.GET, { params: { slug: slug(), id: run.id }, headers: viewer })).status).toBe(200);
    const shot = await callRoute(artifactRoute.GET, { params: { slug: slug(), id: run.id, artifactId: artifact.id }, headers: viewer });
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect(shot.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await callRoute(groupRoute.GET, { params: { slug: slug(), groupId: group.id }, headers: viewer })).status).toBe(200);
  });

  it("attachments: list by name, download never inline, delete allowed while runs are active", async () => {
    const put = async (version: number) => {
      const key = `workspaces/${ctx.workspace.id}/attachments/v${version}-${Date.now()}.bin`;
      await getStorage().put(key, Readable.from([Buffer.from(`<script>alert(${version})</script>`)]));
      return getDb().attachment.create({ data: { workspaceId: ctx.workspace.id, name: "évil page.html", version, storageKey: key, contentType: "text/html", sizeBytes: 25 } });
    };
    const v1 = await put(1);
    const v2 = await put(2);
    const list = await callRoute(attachmentsRoute.GET, { params: { slug: slug() }, headers: viewer });
    expect((await list.json()).attachments).toMatchObject([{ name: "évil page.html", versions: [{ id: v2.id, version: 2 }, { id: v1.id, version: 1 }] }]);

    const download = await callRoute(attachmentRoute.GET, { params: { slug: slug(), attachmentId: v2.id }, headers: viewer });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="_vil page.html"; filename\*=UTF-8''%C3%A9vil%20page.html$/);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-security-policy")).toContain("sandbox");

    const editor = await sessionHeaders(ctx.users.EDITOR.id);
    await makeRun(ctx.workspace.id, s, { status: "running" }); // runs don't pin attachments
    for (const v of [v1, v2]) {
      const res = await callRoute(attachmentRoute.DELETE, { method: "DELETE", params: { slug: slug(), attachmentId: v.id }, headers: editor });
      expect(res.status).toBe(204);
      expect(await getStorage().stat(v.storageKey)).toBeNull();
    }
  });

  it("SSE: full snapshot first, then changes, then end and close when the run finishes", async () => {
    const run = await makeRun(ctx.workspace.id, s, { status: "running" });
    const res = await events(run.id, viewer);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const first = await readEvents(res, (e) => e.type === "snapshot");
    opened.push(first.reader);
    expect(first.events[0]).toMatchObject({ type: "snapshot", run: { id: run.id, status: "running" } });

    await getDb().stepResult.create({ data: { runId: run.id, index: 0, stepId: "s1", action: "goto", status: "passed", attempts: 1, startedAt: new Date(), durationMs: 120 } });
    await getDb().run.update({ where: { id: run.id }, data: { status: "passed", finishedAt: new Date() } });

    // Same reader: keep reading the same stream.
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const chunk = await first.reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    const later = text.split("\n\n").flatMap((b) => b.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))));
    expect(later.map((e) => e.type)).toEqual(["update", "end"]);
    expect(later[0]).toMatchObject({ run: { status: "passed" }, steps: [{ index: 0, result: { status: "passed", durationMs: 120 } }] });
  });

  it("SSE: a finished run sends its snapshot and closes; reconnecting sends the full state again", async () => {
    const run = await makeRun(ctx.workspace.id, s, { status: "failed", durations: [100, 200], stepStatus: ["passed", "failed"] });
    for (let i = 0; i < 2; i++) {
      const read = await readEvents(await events(run.id, viewer), () => false, 3000);
      expect(read.ended).toBe(true);
      expect(read.events.map((e) => e.type)).toEqual(["snapshot", "end"]);
      expect(read.events[0]).toMatchObject({ run: { status: "failed", steps: [{ result: { status: "passed" } }, { result: { status: "failed" } }] } });
    }
  });

  it("SSE: closes without sending more once the user loses access", async () => {
    const run = await makeRun(ctx.workspace.id, s, { status: "running" });
    const res = await events(run.id, viewer);
    const first = await readEvents(res, (e) => e.type === "snapshot");
    opened.push(first.reader);
    await getDb().membership.deleteMany({ where: { userId: ctx.users.VIEWER.id, workspaceId: ctx.workspace.id } });
    await getDb().run.update({ where: { id: run.id }, data: { status: "passed", finishedAt: new Date() } });
    const rest = await readEvents(new Response(new ReadableStream({ start: (c) => void pump(first.reader, c) })), () => false, 4000);
    expect(rest.ended).toBe(true);
    expect(rest.events).toEqual([]);
  });

  it("SSE: closes when the user is disabled", async () => {
    const run = await makeRun(ctx.workspace.id, s, { status: "running" });
    const first = await readEvents(await events(run.id, viewer), (e) => e.type === "snapshot");
    opened.push(first.reader);
    await getDb().user.update({ where: { id: ctx.users.VIEWER.id }, data: { disabledAt: new Date() } });
    const rest = await readEvents(new Response(new ReadableStream({ start: (c) => void pump(first.reader, c) })), () => false, 4000);
    expect(rest.ended).toBe(true);
    expect(rest.events).toEqual([]);
  });

  it("SSE: caps open streams per user and frees the slot when one closes", async () => {
    process.env.SSE_MAX_CONNECTIONS_PER_USER = "2";
    try {
      const run = await makeRun(ctx.workspace.id, s, { status: "running" });
      const a = await events(run.id, viewer);
      const b = await events(run.id, viewer);
      expect([a.status, b.status]).toEqual([200, 200]);
      const c = await events(run.id, viewer);
      expect(c.status).toBe(429);
      expect((await c.json()).error.code).toBe("too_many_connections");
      await a.body!.cancel();
      const d = await events(run.id, viewer);
      expect(d.status).toBe(200);
      await Promise.all([b.body!.cancel(), d.body!.cancel()]);
    } finally {
      delete process.env.SSE_MAX_CONNECTIONS_PER_USER;
    }
  });

  it("changed since last pass: compares with the latest earlier pass on the same environment only", async () => {
    await makeRun(ctx.workspace.id, s, { status: "passed", durations: [1000, 500], runnerVersion: "0.1.0" });
    const baseline = await makeRun(ctx.workspace.id, s, { status: "passed", durations: [1100, 400] });
    await makeRun(ctx.workspace.id, s, { status: "passed", env: "prod", durations: [9000, 9000] });
    const current = await makeRun(ctx.workspace.id, s, { status: "failed", durations: [2600, 15000], stepStatus: ["passed", "failed"], runnerVersion: "0.2.0" });
    const view = await getRunChanges(ctx.workspace.id, current.id);
    expect(view?.baseline?.id).toBe(baseline.id);
    expect(view?.changes).toEqual([
      { kind: "outcome", index: 1, status: "failed", previous: "passed" },
      { kind: "slowStep", index: 0, durationMs: 2600, usualMs: 1050 },
      { kind: "runnerVersion", from: "0.1.0", to: "0.2.0" },
    ]);
    const first = await getDb().run.findFirstOrThrow({ orderBy: { queuedAt: "asc" } });
    expect(await getRunChanges(ctx.workspace.id, first.id)).toEqual({ baseline: null, changes: [] });
    expect(await getRunChanges(ctx.other.id, current.id)).toBeNull();
  });
});

async function pump(reader: ReadableStreamDefaultReader<Uint8Array>, controller: ReadableStreamDefaultController<Uint8Array>) {
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return controller.close();
    controller.enqueue(chunk.value);
  }
}
