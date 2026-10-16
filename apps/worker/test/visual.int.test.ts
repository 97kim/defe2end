// Visual regression through the worker (stage 7 contract sections 4 and 8): real Postgres, fixture pages and
// Chromium. Runs are queued the way run creation does it, with their baselines pinned in the same transaction.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { approveBaseline, checkReportedVisualVerdict, pinVisualBaselines, settleCreatedBaseline } from "@defe2end/db";
import { runSnapshotSchema, type Step } from "@defe2end/shared";
import { artifactKey, LocalStorage, storageBaselineFiles } from "@defe2end/shared/server";
import { startFixtureServer, type FixtureServer } from "@defe2end/test-fixtures";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { WorkerConfig } from "../src/config.js";
import { createWorker, type Worker } from "../src/worker.js";
import { describeDb, getDb, resetDatabase, seedRun, testConfig, waitForStatus } from "./helpers.js";

const shotOf = (path: string, extra: Partial<Step> = {}): Step[] => [
  { id: "go", action: "goto", url: path },
  { id: "shot", action: "screenshot", name: "page", ...extra } as Step,
];

describeDb("visual regression", () => {
  let fixtures: FixtureServer;
  let worker: Worker | undefined;
  let config: WorkerConfig;
  let storage: LocalStorage;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });
  afterAll(() => fixtures.close());
  beforeEach(async () => {
    await resetDatabase();
    config = await testConfig();
    storage = new LocalStorage(config.storageDir);
  });
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
  });

  /** A scenario with no runs yet; `queue` adds pinned runs of it. */
  async function scenario(steps: Step[]) {
    const seeded = await seedRun({ baseUrl: fixtures.url, steps });
    const template = await getDb().run.findUniqueOrThrow({ where: { id: seeded.runId } });
    await getDb().run.delete({ where: { id: seeded.runId } });
    const queue = (runSteps: Step[] = steps) =>
      getDb().$transaction(async (tx) => {
        const base = runSnapshotSchema.parse(template.snapshot);
        const snapshot = { ...base, scenario: { ...base.scenario, steps: runSteps } };
        const pinned = await pinVisualBaselines(tx, { scenarioId: template.scenarioId, environmentId: template.environmentId!, location: "server", snapshot });
        const run = await tx.run.create({ data: { workspaceId: template.workspaceId, scenarioId: template.scenarioId, environmentId: template.environmentId, trigger: "manual", snapshot: pinned.snapshot } });
        if (pinned.versionIds.length) await tx.runBaselinePin.createMany({ data: pinned.versionIds.map((versionId) => ({ runId: run.id, versionId })) });
        return run.id;
      });
    return { ...template, queue };
  }

  async function start() {
    worker = createWorker(getDb(), config);
    await worker.start();
  }

  const shotStep = (runId: string) => getDb().stepResult.findFirstOrThrow({ where: { runId, stepId: "shot" }, orderBy: { attempt: "desc" } });

  it("first run creates the baseline, an identical run matches, a change warns, approval makes the next run match", async () => {
    const sc = await scenario(shotOf("/login.html"));
    await start();

    const first = await sc.queue();
    expect(await waitForStatus(first, ["passed", "failed", "error"])).toMatchObject({ status: "passed", warningCount: 0 });
    const created = await shotStep(first);
    expect(created).toMatchObject({ status: "passed", visualVerdict: "created", visualServerVerdict: null });
    expect(created.render).toMatchObject({ maskingPolicyVersion: 1, viewport: { width: 1280, height: 720 } });
    const v1 = await getDb().visualBaselineVersion.findFirstOrThrow({ include: { baseline: true } });
    expect(v1).toMatchObject({ version: 1, source: "auto", sourceRunId: first, width: 1280, height: 720 });
    expect(v1.baseline).toMatchObject({ stepId: "shot", device: "1280x720", runtime: "server", currentVersion: 1 });
    expect(created.visualBaselineVersionId).toBe(v1.id);
    // A separate copy, not the run's file.
    const shot = await getDb().artifact.findFirstOrThrow({ where: { runId: first, kind: "screenshot" } });
    expect(v1.storageKey).not.toBe(shot.storageKey);
    expect(await readFile(join(config.storageDir, v1.storageKey))).toEqual(await readFile(join(config.storageDir, shot.storageKey)));
    expect(await getDb().runBaselinePin.count()).toBe(0);

    const same = await sc.queue();
    expect(await getDb().runBaselinePin.findMany({ where: { runId: same } })).toEqual([{ runId: same, versionId: v1.id }]);
    await waitForStatus(same, ["passed", "failed", "error"]);
    expect(await shotStep(same)).toMatchObject({ status: "passed", visualVerdict: "match", visualBaselineVersionId: v1.id, visualDiffPercent: 0 });
    expect(await getDb().runBaselinePin.count()).toBe(0);

    // Same scenario and step id, other page (tolerance 0: the pages differ by under 1%): the step changed. A step inserted before it keeps the key.
    const changed = await sc.queue([{ id: "extra", action: "wait", value: "10" } as Step, ...shotOf("/products.html", { threshold: 0 })]);
    expect(await waitForStatus(changed, ["passed", "failed", "error"])).toMatchObject({ status: "passed", warningCount: 1 });
    const warned = await shotStep(changed);
    expect(warned).toMatchObject({ status: "warning", errorCode: "warning", visualVerdict: "changed", visualBaselineVersionId: v1.id });
    expect(warned.errorMessage).toMatch(/differs from the baseline by .*approve it as the new baseline/);
    expect(await getDb().artifact.count({ where: { runId: changed, kind: "visual_diff" } })).toBe(1);

    // Approval: stale expected version 409, then a new version, then the same answer again.
    const files = storageBaselineFiles(storage);
    const user = await getDb().user.create({ data: { id: `u${Date.now()}`, email: `a${Date.now()}@x.test`, name: "A" } });
    const approve = (expectedVersion: number) => approveBaseline(getDb(), files, { workspaceId: sc.workspaceId, runId: changed, stepResultId: warned.id, expectedVersion, userId: user.id });
    expect(await approve(0)).toMatchObject({ ok: false, status: 409 });
    expect(await approve(1)).toMatchObject({ ok: true, version: 2, created: true });
    expect(await approve(1)).toMatchObject({ ok: true, version: 2, created: false });
    expect(await getDb().visualBaselineVersion.count()).toBe(2);
    // Other workspace: not found.
    expect(await approveBaseline(getDb(), files, { workspaceId: "other", runId: changed, stepResultId: warned.id, expectedVersion: 2, userId: user.id })).toMatchObject({ ok: false, status: 404 });

    const after = await sc.queue(shotOf("/products.html", { threshold: 0 }));
    await waitForStatus(after, ["passed", "failed", "error"]);
    const v2 = await getDb().visualBaselineVersion.findFirstOrThrow({ where: { version: 2 } });
    expect(await shotStep(after)).toMatchObject({ status: "passed", visualVerdict: "match", visualBaselineVersionId: v2.id });
    // The older result still names the version it used.
    expect((await shotStep(changed)).visualBaselineVersionId).toBe(v1.id);
  }, 120_000);

  it("other render conditions are incomparable; another device gets its own baseline", async () => {
    const sc = await scenario(shotOf("/login.html"));
    await start();
    const first = await sc.queue();
    await waitForStatus(first, ["passed", "failed", "error"]);
    const v1 = await getDb().visualBaselineVersion.findFirstOrThrow();
    await getDb().visualBaselineVersion.update({ where: { id: v1.id }, data: { render: { ...(v1.render as object), browserVersion: "1.0" } } });
    const next = await sc.queue();
    expect(await waitForStatus(next, ["passed", "failed", "error"])).toMatchObject({ status: "passed", warningCount: 0 });
    expect(await shotStep(next)).toMatchObject({ status: "passed", visualVerdict: "incomparable", visualBaselineVersionId: v1.id });

    await getDb().$transaction(async (tx) => {
      const pinned = await pinVisualBaselines(tx, { scenarioId: sc.scenarioId, environmentId: sc.environmentId!, location: "server", snapshot: { ...runSnapshotSchema.parse(sc.snapshot), device: { viewport: { width: 800, height: 600 } } } });
      expect(pinned.versionIds).toEqual([]);
      expect(pinned.snapshot.visual).toEqual({ device: "800x600", baselines: [{ stepId: "shot", runtime: "server", versionId: null }] });
    });
    // A desktop run pins per desktop runtime, never the server's baseline.
    await getDb().$transaction(async (tx) => {
      const pinned = await pinVisualBaselines(tx, { scenarioId: sc.scenarioId, environmentId: sc.environmentId!, location: "desktop", snapshot: runSnapshotSchema.parse(sc.snapshot) });
      expect(pinned.versionIds).toEqual([]);
      expect(pinned.snapshot.visual!.baselines.map((b) => b.runtime)).toEqual(["desktop-mac", "desktop-windows"]);
    });
  }, 120_000);

  it("racing first baselines: one is created, the other is compared on the server; forged versions are skipped", async () => {
    const sc = await scenario(shotOf("/login.html"));
    const png = await (async () => {
      worker = createWorker(getDb(), config);
      await worker.start();
      const id = await sc.queue();
      await waitForStatus(id, ["passed", "failed", "error"]);
      await worker.stop();
      worker = undefined;
      const a = await getDb().artifact.findFirstOrThrow({ where: { runId: id, kind: "screenshot" } });
      return readFile(join(config.storageDir, a.storageKey));
    })();
    // Start over without baselines, then two runs that both saw none.
    await getDb().visualBaseline.deleteMany();
    const racers = [await sc.queue(), await sc.queue()];
    const render = (await getDb().stepResult.findFirstOrThrow({ where: { stepId: "shot" } })).render as object;
    const stepIds: string[] = [];
    for (const runId of racers) {
      await getDb().run.update({ where: { id: runId }, data: { status: "running" } });
      const key = artifactKey(sc.workspaceId, runId, "png");
      await storage.put(key, Readable.from([png]));
      await getDb().artifact.create({ data: { runId, workspaceId: sc.workspaceId, kind: "screenshot", stepIndex: 1, name: "page", storageKey: key, contentType: "image/png", sizeBytes: png.length } });
      const step = await getDb().stepResult.create({ data: { runId, index: 1, stepId: "shot", action: "screenshot", status: "passed", attempts: 1, startedAt: new Date(), durationMs: 1, visualVerdict: "created", render } });
      stepIds.push(step.id);
    }
    const files = storageBaselineFiles(storage);
    const verdicts = await Promise.all(stepIds.map((id) => settleCreatedBaseline(getDb(), files, id)));
    expect(verdicts.sort()).toEqual(["created", "match"]);
    expect(await getDb().visualBaselineVersion.count()).toBe(1);
    const loser = await getDb().stepResult.findFirstOrThrow({ where: { id: { in: stepIds }, visualServerVerdict: "match" } });
    expect(loser.visualBaselineVersionId).toBe((await getDb().visualBaselineVersion.findFirstOrThrow()).id);

    // An app claiming a version that isn't pinned for its run.
    const forged = await getDb().stepResult.update({ where: { id: loser.id }, data: { visualVerdict: "match", visualServerVerdict: null } });
    expect(await checkReportedVisualVerdict(getDb(), forged.id)).toBe("skipped");
    expect(await getDb().stepResult.findUniqueOrThrow({ where: { id: forged.id } })).toMatchObject({ visualVerdict: "skipped", visualBaselineVersionId: null });
  }, 120_000);
});
