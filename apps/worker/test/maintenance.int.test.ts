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
});
