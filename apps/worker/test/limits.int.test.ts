// Resource limits and whole flows through real workers: real Postgres, fixture server, real Chromium
// (stage 3 contract sections 3, 4.3, 4.4 and 7).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listMarkedBrowsers } from "@defe2end/runner";
import type { Step } from "@defe2end/shared";
import { LocalStorage } from "@defe2end/shared/server";
import { startFixtureServer, type FixtureServer } from "@defe2end/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { WorkerConfig } from "../src/config.js";
import { createWorker, type Worker } from "../src/worker.js";
import { describeDb, getDb, resetDatabase, seedGroup, seedRun, testConfig, waitFor, waitForStatus } from "./helpers.js";

const TERMINAL = ["passed", "failed", "error", "cancelled", "timed_out"];
/** Holds a browser for about `ms`, then fails (no `#never` element on the page). */
const hold = (ms: number): Step[] => [
  { id: "s1", action: "goto", url: "/" },
  { id: "s2", action: "waitForSelector", selector: "#never", timeout: ms },
];

describeDb("limits through real workers", () => {
  let fixtures: FixtureServer;
  const workers: Worker[] = [];

  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });
  afterAll(() => fixtures.close());
  beforeEach(resetDatabase);
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
  });

  async function start(overrides: Partial<WorkerConfig> = {}) {
    const config = await testConfig(overrides);
    const worker = createWorker(getDb(), config);
    workers.push(worker);
    await worker.start();
    return config;
  }

  it("two workers never pass MAX_CONCURRENT_RUNS, nor their own WORKER_CONCURRENCY", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await seedRun({ baseUrl: fixtures.url, steps: hold(2_500), retryOnFailure: false })).runId);
    await Promise.all([start({ workerId: "wa", concurrency: 2, maxConcurrentRuns: 3 }), start({ workerId: "wb", concurrency: 2, maxConcurrentRuns: 3 })]);
    let maxTotal = 0;
    const maxPerWorker: Record<string, number> = {};
    await waitFor(async () => {
      const running = await getDb().run.findMany({ where: { status: "running" }, select: { workerId: true } });
      maxTotal = Math.max(maxTotal, running.length);
      const per: Record<string, number> = {};
      for (const r of running) per[r.workerId!] = (per[r.workerId!] ?? 0) + 1;
      for (const [w, n] of Object.entries(per)) maxPerWorker[w] = Math.max(maxPerWorker[w] ?? 0, n);
      return (await getDb().run.count({ where: { id: { in: ids }, status: { in: ["failed"] } } })) === 6;
    }, 60_000);
    expect(maxTotal).toBe(3);
    expect(Math.max(...Object.values(maxPerWorker))).toBeLessThanOrEqual(2);
    expect(Object.keys(maxPerWorker).sort()).toEqual(["wa", "wb"]);
  });

  it("a worker below MIN_FREE_DISK_MB claims nothing", async () => {
    const { runId } = await seedRun({ baseUrl: fixtures.url, steps: hold(100) });
    await start({ minFreeDiskMb: Number.MAX_SAFE_INTEGER });
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await getDb().run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("queued");
  });

  it("over the per-run artifact total: collection stops, error(artifact_limit), no stray file", async () => {
    const config = await start({ runArtifactBytes: 2_000 });
    const { runId, workspaceId } = await seedRun({
      baseUrl: fixtures.url,
      steps: [
        { id: "s1", action: "goto", url: "/" },
        { id: "s2", action: "screenshot", name: "big" },
        { id: "s3", action: "click", selector: "a" },
      ],
    });
    const run = await waitForStatus(runId, TERMINAL);
    expect(run).toMatchObject({ status: "error", errorCode: "artifact_limit" });
    const results = await getDb().stepResult.findMany({ where: { runId }, orderBy: { index: "asc" } });
    expect(results.map((r) => r.status)).toEqual(["passed", "error", "skipped"]);
    const registered = new Set((await getDb().artifact.findMany({ where: { runId } })).map((a) => a.storageKey));
    const files: string[] = [];
    for await (const f of new LocalStorage(config.storageDir).list(`workspaces/${workspaceId.toLowerCase()}/`)) files.push(f.key);
    expect(files.filter((k) => !registered.has(k))).toEqual([]);
  });

  it("a test run (no scenario) runs from its snapshot steps", async () => {
    await start();
    const { runId } = await seedRun({ baseUrl: fixtures.url, steps: [{ id: "t1", action: "goto", url: "/login.html" }, { id: "t2", action: "assertText", selector: "h1", expected: "Log in" }] });
    await getDb().run.update({ where: { id: runId }, data: { trigger: "test", scenarioId: null } });
    expect((await waitForStatus(runId, TERMINAL)).status).toBe("passed");
  });

  it("a sequential group stops after a failing child and ends failed", async () => {
    await start({ concurrency: 2 });
    const g = await seedGroup({ size: 3, mode: "sequential", continueOnFailure: false, baseUrl: fixtures.url, steps: hold(300) });
    await waitFor(async () => (await getDb().groupRun.findUniqueOrThrow({ where: { id: g.groupRunId } })).finishedAt);
    const runs = await getDb().run.findMany({ where: { groupRunId: g.groupRunId }, orderBy: { groupIndex: "asc" } });
    expect(runs.map((r) => [r.status, r.errorCode])).toEqual([["failed", null], ["cancelled", "group_stopped"], ["cancelled", "group_stopped"]]);
    expect((await getDb().groupRun.findUniqueOrThrow({ where: { id: g.groupRunId } })).status).toBe("failed");
  });
});

describeDb("lease renewals stalling", () => {
  let fixtures: FixtureServer;
  let worker: Worker | undefined;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });
  afterAll(async () => {
    await worker?.stop();
    await fixtures.close();
  });
  beforeEach(resetDatabase);

  it("stops the browser before the last confirmed expiry and writes nothing after it", async () => {
    worker = createWorker(getDb(), await testConfig()); // 1 s heartbeat, 6 s lease
    await worker.start();
    const { runId } = await seedRun({ baseUrl: fixtures.url, steps: hold(120_000) });
    await waitFor(() => getDb().stepResult.findFirst({ where: { runId, index: 0 } }));
    // Hold the run row: every renewal (and any other owned write) now waits behind this lock.
    let gone: { at: Date; expiry: Date } | undefined;
    await getDb().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Run" WHERE id = ${runId} FOR UPDATE`;
        const [row] = await tx.$queryRaw<{ expiry: Date }[]>`SELECT "leaseExpiresAt" AS expiry FROM "Run" WHERE id = ${runId}`;
        const expiry = row!.expiry;
        await waitFor(async () => (await listMarkedBrowsers()).every((p) => p.runId !== runId), 15_000);
        const [clock] = await getDb().$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        gone = { at: clock!.now, expiry };
        // Keep the lock past the expiry, so the delayed renewal finds it expired.
        await waitFor(async () => (await getDb().$queryRaw<{ late: boolean }[]>`SELECT clock_timestamp() > ${expiry} AS late`)[0]!.late);
      },
      { timeout: 30_000 },
    );
    expect(gone!.at.getTime()).toBeLessThan(gone!.expiry.getTime());
    const run = await waitForStatus(runId, TERMINAL, 15_000);
    expect(run).toMatchObject({ status: "error", errorCode: "worker_lost" });
    const steps = await getDb().stepResult.findMany({ where: { runId }, orderBy: { index: "asc" } });
    expect(steps.map((r) => r.status)).toEqual(["passed"]); // the stopped step's result came after the lease: refused
    expect(run.heartbeatAt!.getTime()).toBeLessThan(gone!.expiry.getTime()); // never renewed once expired
  });
});

describeDb("worker SIGTERM", () => {
  let fixtures: FixtureServer;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    await resetDatabase();
  });
  afterAll(() => fixtures.close());

  it("stops claiming, keeps the lease alive through the grace, then kills the browser and ends error(worker_shutdown)", async () => {
    const { storageDir } = await testConfig();
    const { runId, workspaceId } = await seedRun({ baseUrl: fixtures.url, steps: hold(120_000) });
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/main.js", import.meta.url))], {
      env: { ...process.env, HEARTBEAT_INTERVAL_MS: "1000", RUN_LEASE_MS: "3000", POLL_INTERVAL_MS: "100", MIN_FREE_DISK_MB: "0", SHUTDOWN_GRACE_MS: "5000", STORAGE_DIR: storageDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    try {
      await waitFor(() => getDb().stepResult.findFirst({ where: { runId, index: 0 } }), 30_000);
      const browsers = (await listMarkedBrowsers()).filter((p) => p.runId === runId);
      expect(browsers.length).toBeGreaterThan(0);

      child.kill("SIGTERM");
      await waitFor(async () => output.includes("SIGTERM received"));
      // A run queued after SIGTERM is not claimed by the stopping worker.
      const late = await seedRun({ baseUrl: fixtures.url, steps: hold(100), workspaceId });
      const before = await getDb().run.findUniqueOrThrow({ where: { id: runId } });
      // Longer than the 3 s lease: only renewals keep the run owned through the 5 s grace.
      await new Promise((r) => setTimeout(r, 4_000));
      const during = await getDb().run.findUniqueOrThrow({ where: { id: runId } });
      expect(during).toMatchObject({ status: "running", errorCode: null });
      expect(during.leaseExpiresAt!.getTime()).toBeGreaterThan(before.leaseExpiresAt!.getTime());

      expect(await exited).toBe(0);
      const run = await getDb().run.findUniqueOrThrow({ where: { id: runId } });
      expect(run).toMatchObject({ status: "error", errorCode: "worker_shutdown" });
      expect((await getDb().stepResult.findMany({ where: { runId }, orderBy: { index: "asc" } })).map((r) => r.status)).toEqual(["passed", "error"]);
      expect((await listMarkedBrowsers()).filter((p) => p.runId === runId)).toEqual([]);
      for (const b of browsers) expect(() => process.kill(-b.pgid, 0)).toThrow();
      expect((await getDb().run.findUniqueOrThrow({ where: { id: late.runId } })).status).toBe("queued");
    } finally {
      child.kill("SIGKILL");
    }
  });
});
