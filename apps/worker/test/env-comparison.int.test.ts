import {
  cancelComparison,
  claimComparison,
  commitComparison,
  ComparisonStartError,
  createEnvComparison,
  deleteExpiredTestRuns,
  enqueueFinishNotifications,
  finishComparisons,
  overallVerdict,
  recompareComparison,
  runComparisonJob,
} from "@defe2end/db";
import { encodePng, LocalStorage } from "@defe2end/shared/server";
import type { Step } from "@defe2end/shared";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createWorker, type Worker } from "../src/worker.js";
import { describeDb, getDb, resetDatabase, testConfig, waitFor } from "./helpers.js";

const ENV = { freeBytes: async () => Number.MAX_SAFE_INTEGER, minFreeBytes: () => 0 };
const RENDER = { browserVersion: "140.0", deviceScaleFactor: 1, viewport: { width: 4, height: 4 }, fontSet: "server", maskingPolicyVersion: 1 };
const STEPS: Step[] = [
  { id: "s1", action: "goto", url: "/" },
  { id: "shot-a", action: "screenshot", value: "home" },
  { id: "shot-b", action: "screenshot", value: "list" },
];

function png(fill: (x: number, y: number) => number): Uint8Array {
  const data = new Uint8Array(4 * 4 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const v = fill(x, y);
    data.set([v, v, v, 255], (y * 4 + x) * 4);
  }
  return encodePng({ width: 4, height: 4, data });
}

async function* once(body: Uint8Array) {
  yield body;
}

let n = 0;
async function seed(opts: { steps?: Step[]; rightBaseUrl?: string } = {}) {
  const db = getDb();
  const i = ++n;
  const workspace = await db.workspace.create({ data: { name: `ws ${i}`, slug: `cmp-${i}-${Date.now()}` } });
  const user = await db.user.create({ data: { id: `u-${i}-${Date.now()}`, name: "Mina", email: `u${i}-${Date.now()}@example.com`, emailVerified: true } });
  await db.membership.create({ data: { userId: user.id, workspaceId: workspace.id, role: "EDITOR" } });
  const site = await db.site.create({ data: { workspaceId: workspace.id, name: "shop" } });
  const left = await db.environment.create({ data: { workspaceId: workspace.id, siteId: site.id, name: "prod", baseUrl: "https://shop.example" } });
  const right = await db.environment.create({ data: { workspaceId: workspace.id, siteId: site.id, name: "stage", baseUrl: opts.rightBaseUrl ?? "https://stage.shop.example" } });
  const scenario = await db.scenario.create({ data: { workspaceId: workspace.id, siteId: site.id, name: "home", steps: opts.steps ?? STEPS } });
  return { workspaceId: workspace.id, userId: user.id, siteId: site.id, leftId: left.id, rightId: right.id, scenarioId: scenario.id };
}

async function start(s: Awaited<ReturnType<typeof seed>>, tolerance?: number) {
  return createEnvComparison(getDb(), { workspaceId: s.workspaceId, userId: s.userId, scenarioId: s.scenarioId, leftEnvironmentId: s.leftId, rightEnvironmentId: s.rightId, location: "server", tolerance }, ENV);
}

/** Ends a child as `status` with screenshot results, images and snapshots (or none). */
async function endChild(
  storage: LocalStorage,
  runId: string,
  status: "passed" | "failed",
  captures: Record<string, { image?: Uint8Array; snapshot?: string; render?: object; status?: "passed" | "failed" }>,
) {
  const db = getDb();
  const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
  for (const [index, step] of STEPS.entries()) {
    const c = captures[step.id];
    if (!c) continue;
    await db.stepResult.create({ data: { runId, index, stepId: step.id, action: step.action, status: c.status ?? "passed", attempts: 1, startedAt: new Date(), durationMs: 1, render: c.render ?? RENDER } });
    for (const [kind, body] of [["screenshot", c.image], ["a11y_snapshot", c.snapshot === undefined ? undefined : new TextEncoder().encode(c.snapshot)]] as const) {
      if (!body) continue;
      const storageKey = `workspaces/${run.workspaceId}/runs/${runId}/${kind}-${index}-${Math.random().toString(36).slice(2)}.bin`;
      await storage.put(storageKey, once(body));
      await db.artifact.create({ data: { runId, workspaceId: run.workspaceId, kind, stepIndex: index, name: step.id, storageKey, contentType: "x", sizeBytes: body.length } });
    }
  }
  await db.run.update({ where: { id: runId }, data: { status, finishedAt: new Date() } });
}

const SNAP_LEFT = '- heading "Shop"\n- link "Home":\n  - /url: https://shop.example/home\n- button "Buy"\n- text "A"\n- text "B"';
const SNAP_RIGHT = '- heading "Shop"\n- link "Home":\n  - /url: https://stage.shop.example/home\n- button "Buy now"\n- text "B"\n- text "A"';

describeDb("environment comparison", () => {
  beforeEach(resetDatabase);

  it("refuses to start with every reason listed", async () => {
    const s = await seed({ steps: [{ id: "s1", action: "goto", url: "/" }], rightBaseUrl: "https://shop.example/" });
    await getDb().environment.update({ where: { id: s.rightId }, data: { useAuthSession: true } });
    const err = await start(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComparisonStartError);
    expect((err as ComparisonStartError).reasons.sort()).toEqual(["auth_session_missing_right", "no_screenshot_step", "same_base_url"]);
    const same = await createEnvComparison(getDb(), { workspaceId: s.workspaceId, userId: s.userId, scenarioId: s.scenarioId, leftEnvironmentId: s.leftId, rightEnvironmentId: s.leftId, location: "server" }, ENV).catch((e: unknown) => e);
    expect((same as ComparisonStartError).reasons).toContain("same_environment");
    expect(await getDb().envComparison.count()).toBe(0);
    expect(await getDb().run.count()).toBe(0);
  });

  it("creates the comparison and two isolated children together", async () => {
    const s = await seed();
    const { comparisonId, runIds } = await start(s);
    const runs = await getDb().run.findMany({ where: { id: { in: runIds } }, orderBy: { comparisonSide: "asc" } });
    expect(runs.map((r) => [r.comparisonId, r.comparisonSide, r.environmentId])).toEqual([[comparisonId, "left", s.leftId], [comparisonId, "right", s.rightId]]);
    for (const r of runs) expect((r.snapshot as { scenario: { retryOnFailure: boolean } }).scenario.retryOnFailure).toBe(false);
    const cmp = await getDb().envComparison.findUniqueOrThrow({ where: { id: comparisonId } });
    expect(cmp).toMatchObject({ status: "running", round: 1, leftBaseUrl: "https://shop.example", rightBaseUrl: "https://stage.shop.example", tolerance: 5 });
    expect(JSON.stringify(cmp.conditions)).not.toMatch(/value"\s*:\s*"secret|encryptedState/);

    // No finish message, and never removed as an expired test run.
    await getDb().run.updateMany({ where: { id: { in: runIds } }, data: { status: "failed", finishedAt: new Date(0), trigger: "test" } });
    await getDb().$transaction((tx) => enqueueFinishNotifications(tx, { runIds })).then((count) => expect(count).toBe(0));
    expect((await deleteExpiredTestRuns(getDb(), 0)).runIds).toEqual([]);
  });

  it("finishes once: screen and element diff, link origins, a render mismatch makes the whole verdict incomparable", async () => {
    const storage = new LocalStorage((await testConfig()).storageDir);
    const s = await seed();
    const { comparisonId, runIds } = await start(s);
    const flat = png(() => 100);
    const half = png(() => 200);
    await endChild(storage, runIds[0], "passed", { "shot-a": { image: flat, snapshot: SNAP_LEFT }, "shot-b": { image: flat, snapshot: "- text \"x\"" } });
    await endChild(storage, runIds[1], "passed", { "shot-a": { image: half, snapshot: SNAP_RIGHT }, "shot-b": { image: flat, snapshot: "- text \"x\"" } });

    // Two finish points race: one claim wins.
    const claims = await Promise.all([claimComparison(getDb(), comparisonId), claimComparison(getDb(), comparisonId)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await runComparisonJob(getDb(), storage, claims.find(Boolean)!)).toBe(true);

    const cmp = await getDb().envComparison.findUniqueOrThrow({ where: { id: comparisonId }, include: { steps: { orderBy: { stepId: "asc" } }, files: true } });
    expect(cmp).toMatchObject({ status: "done", screenVerdict: "different", structureVerdict: "different", claimToken: null });
    const [a, b] = cmp.steps;
    expect(a).toMatchObject({ stepId: "shot-a", screenVerdict: "different", screenDiffPercent: 100, structureVerdict: "different", structureMoved: 1, structureChanged: 1 });
    expect(a!.screenDiffKey).toBeTruthy();
    expect(b).toMatchObject({ stepId: "shot-b", screenVerdict: "same", screenDiffPercent: 0, structureVerdict: "same" });
    // A diff image even when the screens are the same (environment mode).
    expect(b!.screenDiffKey).toBeTruthy();
    for (const f of cmp.files) expect(f.storageKey).toContain(f.claimToken);
    const diff = JSON.parse((await readText(storage, a!.structureDiffKey!)).toString());
    expect(JSON.stringify(diff)).not.toContain("stage.shop.example");

    // Compare again with tolerance 100 and a render mismatch on the other step: incomparable overall.
    await getDb().stepResult.updateMany({ where: { runId: runIds[1], stepId: "shot-b" }, data: { render: { ...RENDER, browserVersion: "141.0" } } });
    const again = await recompareComparison(getDb(), s.workspaceId, comparisonId, 100);
    expect(again.ok).toBe(true);
    expect(await runComparisonJob(getDb(), storage, (again as { ok: true; claim: never }).claim)).toBe(true);
    const round2 = await getDb().envComparison.findUniqueOrThrow({ where: { id: comparisonId }, include: { steps: { where: { round: 2 }, orderBy: { stepId: "asc" } } } });
    expect(round2).toMatchObject({ round: 2, tolerance: 100, screenVerdict: "incomparable", structureVerdict: "incomparable" });
    expect(round2.steps[0]).toMatchObject({ screenVerdict: "same" });
    expect(round2.steps[1]).toMatchObject({ screenVerdict: "incomparable" });
    expect(round2.steps[1]!.reason).toContain("render_mismatch:browserVersion");
    expect(await getDb().envComparisonStep.count({ where: { comparisonId, round: 1 } })).toBe(2);
  });

  it("a failed child or a missing snapshot (masking failure) is incomparable", async () => {
    const storage = new LocalStorage((await testConfig()).storageDir);
    const s = await seed();
    const { comparisonId, runIds } = await start(s);
    const img = png(() => 1);
    await endChild(storage, runIds[0], "passed", { "shot-a": { image: img }, "shot-b": { image: img, snapshot: "- a" } });
    await endChild(storage, runIds[1], "failed", { "shot-a": { image: png(() => 250), snapshot: "- a" }, "shot-b": { image: img, status: "failed" } });
    expect(await finishComparisons(getDb(), storage)).toBe(1);
    const cmp = await getDb().envComparison.findUniqueOrThrow({ where: { id: comparisonId }, include: { steps: { orderBy: { stepId: "asc" } } } });
    expect(cmp).toMatchObject({ status: "done", screenVerdict: "incomparable", structureVerdict: "incomparable" });
    expect(cmp.steps[0]!.reason).toContain("masking_failed");
    // The step's screens still compare; only the whole verdict turns incomparable.
    expect(cmp.steps[0]).toMatchObject({ screenVerdict: "different", structureVerdict: "incomparable" });
    expect(cmp.steps[1]).toMatchObject({ reason: "child_failed", screenVerdict: "incomparable" });
    expect(overallVerdict([{ verdict: "same" }], false)).toBe("incomparable");
    expect(overallVerdict([{ verdict: "different" }, { verdict: "incomparable" }], true)).toBe("different");
    expect(overallVerdict([{ verdict: "different" }, { verdict: "same", taints: true }], true)).toBe("incomparable");
  });

  it("a job that died is re-claimed after the claim expires; the late job can't write", async () => {
    const storage = new LocalStorage((await testConfig()).storageDir);
    const s = await seed();
    const { comparisonId, runIds } = await start(s);
    const img = png(() => 5);
    for (const id of runIds) await endChild(storage, id, "passed", { "shot-a": { image: img, snapshot: "- a" }, "shot-b": { image: img, snapshot: "- b" } });
    // The job's process dies right after claiming: nothing stored; the claim runs out.
    const dead = (await claimComparison(getDb(), comparisonId))!;
    expect(await finishComparisons(getDb(), storage)).toBe(0);
    await getDb().envComparison.update({ where: { id: comparisonId }, data: { claimExpiresAt: new Date(Date.now() - 1000) } });
    expect(await commitComparison(getDb(), dead, { steps: [], screenVerdict: "same", structureVerdict: "same" })).toBe(false);
    expect(await claimComparison(getDb(), comparisonId)).toBeTruthy();
    await getDb().envComparison.update({ where: { id: comparisonId }, data: { claimExpiresAt: new Date(Date.now() - 1000) } });
    expect(await finishComparisons(getDb(), storage)).toBe(1);
    const cmp = await getDb().envComparison.findUniqueOrThrow({ where: { id: comparisonId } });
    expect(cmp).toMatchObject({ status: "done", screenVerdict: "same", structureVerdict: "same" });
    // The stale claim still can't write after the new job is done.
    expect(await commitComparison(getDb(), dead, { error: "late" })).toBe(false);
  });

  it("compare again and cancel race: a stale claim never writes", async () => {
    const storage = new LocalStorage((await testConfig()).storageDir);
    const s = await seed();
    const { comparisonId, runIds } = await start(s);
    const img = png(() => 5);
    for (const id of runIds) await endChild(storage, id, "passed", { "shot-a": { image: img, snapshot: "- a" }, "shot-b": { image: img, snapshot: "- b" } });
    expect(await finishComparisons(getDb(), storage, [comparisonId])).toBe(1);
    const first = await recompareComparison(getDb(), s.workspaceId, comparisonId);
    expect((await recompareComparison(getDb(), s.workspaceId, comparisonId)).ok).toBe(false);
    expect(await cancelComparison(getDb(), s.workspaceId, comparisonId, s.userId)).toMatchObject({ ok: false, code: "conflict" });
    expect(await runComparisonJob(getDb(), storage, (first as { ok: true; claim: never }).claim)).toBe(true);
    expect((await recompareComparison(getDb(), s.workspaceId, comparisonId, 101)).ok).toBe(false);
    expect(await recompareComparison(getDb(), "other-ws", comparisonId)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("cancels a running comparison and its children in one go", async () => {
    const s = await seed();
    const { comparisonId, runIds } = await start(s);
    await getDb().run.update({ where: { id: runIds[1] }, data: { status: "running" } });
    expect(await cancelComparison(getDb(), "other-ws", comparisonId, s.userId)).toMatchObject({ ok: false, code: "not_found" });
    expect(await cancelComparison(getDb(), s.workspaceId, comparisonId, s.userId)).toEqual({ ok: true });
    const runs = await getDb().run.findMany({ where: { id: { in: runIds } }, orderBy: { comparisonSide: "asc" } });
    expect(runs[0]).toMatchObject({ status: "cancelled" });
    expect(runs[1]).toMatchObject({ status: "running" });
    expect(runs[1]!.cancelRequestedAt).not.toBeNull();
    expect((await getDb().envComparison.findUniqueOrThrow({ where: { id: comparisonId } })).status).toBe("cancelled");
    // A cancelled comparison is never claimed or compared again.
    await getDb().run.update({ where: { id: runIds[1] }, data: { status: "cancelled", finishedAt: new Date() } });
    expect(await claimComparison(getDb(), comparisonId)).toBeNull();
    expect((await recompareComparison(getDb(), s.workspaceId, comparisonId)).ok).toBe(false);
  });

  it("an app comparison is cancelled by the device owner only", async () => {
    const s = await seed();
    const { comparisonId } = await start(s);
    const device = await getDb().desktopDevice.create({ data: { userId: s.userId, installId: "i-1", label: "mac" } });
    await getDb().envComparison.update({ where: { id: comparisonId }, data: { location: "desktop", deviceId: device.id } });
    expect(await cancelComparison(getDb(), s.workspaceId, comparisonId, "someone-else")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await cancelComparison(getDb(), s.workspaceId, comparisonId, s.userId)).toEqual({ ok: true });
  });
});

async function readText(storage: LocalStorage, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of await storage.get(key)) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

// End to end through a real worker and browser: the children record render conditions and snapshots, so the
// comparison ends with a real verdict. (The tests above insert step rows by hand and can't catch a runner
// that forgets the render conditions.)
describeDb("environment comparison through the worker", () => {
  let server: Server;
  let origin: string;
  let worker: Worker | undefined;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const right = req.url?.startsWith("/changed/") ?? false;
      res.writeHead(200, { "content-type": "text/html" }).end(
        `<body style="margin:0"><h1>${right ? "Sale today" : "Shop"}</h1><a href="${origin}/home">Home</a><div style="width:100%;height:600px;background:${right ? "#c00" : "#08c"}"></div></body>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(resetDatabase);
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
  });

  async function compare(rightPath: string) {
    const steps: Step[] = [
      { id: "s1", action: "goto", url: "page" },
      { id: "shot", action: "screenshot", value: "home" },
    ];
    const s = await seed({ steps, rightBaseUrl: `${origin}/${rightPath}/` });
    await getDb().environment.update({ where: { id: s.leftId }, data: { baseUrl: `${origin}/left/` } });
    const { comparisonId } = await start(s);
    worker ??= createWorker(getDb(), await testConfig());
    await worker.start();
    return waitFor(async () => {
      const c = await getDb().envComparison.findUniqueOrThrow({ where: { id: comparisonId }, include: { steps: true } });
      return (c.status === "done" || c.status === "error") && c;
    }, 60_000);
  }

  it("ends same for the same page in two environments", async () => {
    const c = await compare("same");
    expect({ status: c.status, screen: c.screenVerdict, structure: c.structureVerdict, error: c.error, reason: c.steps[0]?.reason }).toEqual({ status: "done", screen: "same", structure: "same", error: null, reason: null });
    expect(c.steps[0]!.reason).toBeNull();
  });

  it("ends different when the screen and structure differ", async () => {
    const c = await compare("changed");
    expect({ status: c.status, screen: c.screenVerdict, structure: c.structureVerdict, error: c.error, reason: c.steps[0]?.reason }).toEqual({ status: "done", screen: "different", structure: "different", error: null, reason: null });
    expect(c.steps[0]).toMatchObject({ structureChanged: 1 });
  });
});
