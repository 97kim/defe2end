// Stop-all scope and the cleanup jobs on a real Postgres and a real storage directory (contract sections 4.2, 7).
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { claimNextRun, stopAllRuns } from "@defe2end/db";
import { artifactKey, attachmentKey, LocalStorage } from "@defe2end/shared/server";
import { beforeEach, expect, it } from "vitest";
import { runMaintenance } from "../src/worker.js";
import { CLAIM, describeDb, getDb, resetDatabase, seedRun, testConfig } from "./helpers.js";

const STEPS = [{ id: "s1", action: "goto" as const, url: "/" }];
const BASE = "http://127.0.0.1:9";
const HOUR = 60 * 60 * 1000;

describeDb("stop-all", () => {
  beforeEach(resetDatabase);

  it("racing creations: runs committed before it are stopped, later ones are not", async () => {
    const { workspaceId } = await seedRun({ baseUrl: BASE, steps: STEPS });
    const template = (await getDb().run.findFirstOrThrow()).snapshot as object;
    const create = () => getDb().run.create({ data: { workspaceId, trigger: "manual", snapshot: template } });
    await create();
    await claimNextRun(getDb(), CLAIM);
    const [, result] = await Promise.all([Promise.all(Array.from({ length: 10 }, create)), stopAllRuns(getDb(), workspaceId)]);
    const runs = await getDb().run.findMany({ where: { workspaceId } });
    const stopped = runs.filter((r) => r.status === "cancelled" || r.cancelRequestedAt !== null);
    expect(stopped.length).toBe(result.cancelled + result.cancelRequested);
    expect(result.cancelRequested).toBe(1);
    // Everything not stopped was created after the stop committed: still queued, untouched.
    for (const r of runs.filter((r) => !stopped.includes(r))) expect(r).toMatchObject({ status: "queued", cancelRequestedAt: null });
    expect(await stopAllRuns(getDb(), workspaceId)).toEqual({ cancelled: runs.length - stopped.length, cancelRequested: 1 });
  });
});

describeDb("cleanup", () => {
  beforeEach(resetDatabase);

  async function oldFile(storage: LocalStorage, key: string, ageMs: number) {
    await storage.put(key, Readable.from([Buffer.from("x")]));
    const when = new Date(Date.now() - ageMs);
    await utimes(join(storage.root, key), when, when);
  }

  it("deletes test runs 24 hours after they end, with their files; keeps younger ones and scenario runs", async () => {
    const config = await testConfig();
    const storage = new LocalStorage(config.storageDir);
    const make = async (trigger: "test" | "manual", finishedAgoMs: number | null) => {
      const { runId, workspaceId } = await seedRun({ baseUrl: BASE, steps: STEPS });
      await getDb().run.update({
        where: { id: runId },
        data: { trigger, scenarioId: trigger === "test" ? null : undefined, status: finishedAgoMs === null ? "queued" : "passed", finishedAt: finishedAgoMs === null ? null : new Date(Date.now() - finishedAgoMs) },
      });
      const key = artifactKey(workspaceId, runId, "png");
      await storage.put(key, Readable.from([Buffer.from("png")]));
      await getDb().artifact.create({ data: { runId, workspaceId, kind: "screenshot", name: "s", storageKey: key, contentType: "image/png", sizeBytes: 3 } });
      return { runId, key };
    };
    const expired = await make("test", 25 * HOUR);
    const young = await make("test", 23 * HOUR);
    const waiting = await make("test", null);
    const scenarioRun = await make("manual", 48 * HOUR);

    const result = await runMaintenance(getDb(), storage, config);
    expect(result.testRuns).toBe(1);
    expect(await getDb().run.findUnique({ where: { id: expired.runId } })).toBeNull();
    expect(await storage.stat(expired.key)).toBeNull();
    for (const kept of [young, waiting, scenarioRun]) {
      expect(await getDb().run.findUnique({ where: { id: kept.runId } })).not.toBeNull();
      expect(await storage.stat(kept.key)).not.toBeNull();
    }
  });

  it("removes old unregistered files and crash temp files; keeps registered and young ones", async () => {
    const config = await testConfig();
    const storage = new LocalStorage(config.storageDir);
    const { runId, workspaceId } = await seedRun({ baseUrl: BASE, steps: STEPS });
    const registered = artifactKey(workspaceId, runId, "png");
    await oldFile(storage, registered, 2 * HOUR);
    await getDb().artifact.create({ data: { runId, workspaceId, kind: "screenshot", name: "s", storageKey: registered, contentType: "image/png", sizeBytes: 1 } });
    const attachment = attachmentKey(workspaceId);
    await oldFile(storage, attachment, 2 * HOUR);
    await getDb().attachment.create({ data: { workspaceId, name: "a", version: 1, storageKey: attachment, contentType: "text/plain", sizeBytes: 1 } });
    const orphan = artifactKey(workspaceId, runId, "png"); // moved into place, registration never happened
    await oldFile(storage, orphan, 2 * HOUR);
    const deletedWorkspace = artifactKey("gone-workspace", "gone-run", "zip");
    await oldFile(storage, deletedWorkspace, 2 * HOUR);
    const inFlight = artifactKey(workspaceId, runId, "png"); // between move and registration right now
    await oldFile(storage, inFlight, 60_000);
    const temp = join(storage.root, ".tmp", "crashed-write");
    await mkdir(dirname(temp), { recursive: true });
    await writeFile(temp, "partial");
    await utimes(temp, new Date(Date.now() - 2 * HOUR), new Date(Date.now() - 2 * HOUR));

    const result = await runMaintenance(getDb(), storage, config);
    expect(result).toMatchObject({ orphans: 2, temp: 1 });
    expect(await storage.stat(orphan)).toBeNull();
    expect(await storage.stat(deletedWorkspace)).toBeNull();
    for (const key of [registered, attachment, inFlight]) expect(await storage.stat(key)).not.toBeNull();
  });

  const RENDER = { browserVersion: "1", deviceScaleFactor: 1, viewport: { width: 1280, height: 720 }, fontSet: "f", maskingPolicyVersion: 1 };

  async function seedBaseline(storage: LocalStorage, versions: number) {
    const { runId, workspaceId } = await seedRun({ baseUrl: BASE, steps: STEPS });
    const run = await getDb().run.findUniqueOrThrow({ where: { id: runId } });
    const baseline = await getDb().visualBaseline.create({
      data: { workspaceId, scenarioId: run.scenarioId!, stepId: "s1", environmentId: run.environmentId!, device: "1280x720", runtime: "server", currentVersion: versions },
    });
    const rows = [];
    for (let version = 1; version <= versions; version++) {
      const key = `workspaces/${workspaceId}/baselines/${baseline.id}/v${version}.png`;
      await oldFile(storage, key, 2 * HOUR);
      rows.push(await getDb().visualBaselineVersion.create({ data: { baselineId: baseline.id, version, storageKey: key, width: 1, height: 1, render: RENDER, source: version === 1 ? "auto" : "approved" } }));
    }
    return { runId, workspaceId, rows };
  }

  it("keeps baseline copies and comparison files out of the orphan sweep", async () => {
    const config = await testConfig();
    const storage = new LocalStorage(config.storageDir);
    const { runId, workspaceId, rows } = await seedBaseline(storage, 1);
    const run = await getDb().run.findUniqueOrThrow({ where: { id: runId } });
    const site = await getDb().environment.findUniqueOrThrow({ where: { id: run.environmentId! } });
    const right = await getDb().environment.create({ data: { workspaceId, siteId: site.siteId, name: "Other", baseUrl: "http://127.0.0.1:8" } });
    const comparison = await getDb().envComparison.create({
      data: {
        workspaceId, scenarioId: run.scenarioId!, siteId: site.siteId, leftEnvironmentId: site.id, rightEnvironmentId: right.id,
        leftBaseUrl: site.baseUrl, rightBaseUrl: right.baseUrl, location: "server", conditions: {},
      },
    });
    const diffKey = `workspaces/${workspaceId}/comparisons/${comparison.id}/1-token-s1.png`;
    await oldFile(storage, diffKey, 2 * HOUR);
    await getDb().envComparisonFile.create({ data: { comparisonId: comparison.id, round: 1, claimToken: "token", kind: "screen_diff", storageKey: diffKey } });
    // A stored result points at it (files of a job that lost its claim are not protected).
    await getDb().envComparisonStep.create({ data: { comparisonId: comparison.id, stepId: "s1", round: 1, screenDiffKey: diffKey } });
    const unregistered = `workspaces/${workspaceId}/baselines/never-registered.png`;
    await oldFile(storage, unregistered, 2 * HOUR);

    const result = await runMaintenance(getDb(), storage, config);
    expect(result.orphans).toBe(1);
    expect(await storage.stat(unregistered)).toBeNull();
    for (const key of [rows[0]!.storageKey, diffKey]) expect(await storage.stat(key)).not.toBeNull();
  });

  it("prunes baseline versions outside the newest five unless a step result or an unfinished run's pin uses them", async () => {
    const config = await testConfig();
    const storage = new LocalStorage(config.storageDir);
    const { runId, rows } = await seedBaseline(storage, 9);
    // v1 judged a step (kept as the evidence of that result), v2 pinned by a running run, v3 and v4 unused.
    const step = await getDb().stepResult.create({
      data: { runId, index: 0, stepId: "s1", action: "screenshot", status: "passed", attempts: 1, startedAt: new Date(), durationMs: 1, visualVerdict: "match", visualBaselineVersionId: rows[0]!.id },
    });
    await getDb().runBaselinePin.create({ data: { runId, versionId: rows[1]!.id } });

    const result = await runMaintenance(getDb(), storage, config);
    expect(result.baselineVersions).toBe(2);
    const left = await getDb().visualBaselineVersion.findMany({ orderBy: { version: "asc" }, select: { version: true } });
    expect(left.map((v) => v.version)).toEqual([1, 2, 5, 6, 7, 8, 9]);
    for (const row of rows.slice(2, 4)) expect(await storage.stat(row.storageKey)).toBeNull();
    for (const row of [rows[0]!, rows[1]!, ...rows.slice(4)]) expect(await storage.stat(row.storageKey)).not.toBeNull();

    // The run ends and drops its pin: v2 goes on the next round; v1 stays while the step result points at it.
    await getDb().runBaselinePin.deleteMany({ where: { runId } });
    expect((await runMaintenance(getDb(), storage, config)).baselineVersions).toBe(1);
    await getDb().stepResult.delete({ where: { id: step.id } });
    expect((await runMaintenance(getDb(), storage, config)).baselineVersions).toBe(1);
    expect(await getDb().visualBaselineVersion.count()).toBe(5);
  });
});
