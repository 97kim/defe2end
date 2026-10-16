// Whole-run retry (action spec 4.3) through the worker: real Postgres + real Chromium.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { requestCancel } from "@defe2end/db";
import type { Step } from "@defe2end/shared";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { WorkerConfig } from "../src/config.js";
import { createWorker, type Worker } from "../src/worker.js";
import { describeDb, getDb, resetDatabase, seedGroup, seedRun, testConfig, waitFor, waitForStatus } from "./helpers.js";

const TERMINAL = ["passed", "failed", "error", "cancelled", "timed_out"];

/** `/flaky?k=<key>` shows "first" on the first request for a key and "second" after that. */
async function startFlakyServer() {
  const hits = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    const key = req.url ?? "/";
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>flaky</title><h1>${n === 1 ? "first" : "second"}</h1>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let keys = 0;
/** Fails on the first visit of a fresh key (the page says "first"), passes on every later one. */
const flaky = (extra: Step[] = []): Step[] => [
  { id: "s1", action: "goto", url: `/flaky?k=${++keys}` },
  { id: "s2", action: "assertText", selector: "h1", expected: "second" },
  ...extra,
];
const alwaysFails: Step[] = [
  { id: "s1", action: "goto", url: "/" },
  { id: "s2", action: "assertText", selector: "h1", expected: "never" },
];

describeDb("whole-run retry", () => {
  let site: Awaited<ReturnType<typeof startFlakyServer>>;
  let worker: Worker | undefined;

  beforeAll(async () => {
    site = await startFlakyServer();
  });
  afterAll(() => site.close());
  beforeEach(resetDatabase);
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
  });

  async function start(overrides: Partial<WorkerConfig> = {}) {
    const config = await testConfig(overrides);
    worker = createWorker(getDb(), config);
    await worker.start();
    return config;
  }

  const stepRows = async (runId: string) =>
    (await getDb().stepResult.findMany({ where: { runId }, orderBy: [{ attempt: "asc" }, { index: "asc" }] })).map((r) => [r.attempt, r.index, r.status]);

  it("a failed attempt is retried once; passing then gives passed + passedAfterRetry, each attempt's results and files kept", async () => {
    await start();
    const { runId } = await seedRun({ baseUrl: site.url, steps: flaky() });
    const run = await waitForStatus(runId, TERMINAL, 60_000);
    expect(run).toMatchObject({ status: "passed", passedAfterRetry: true, attemptCount: 2, errorCode: null });
    expect(await stepRows(runId)).toEqual([[1, 0, "passed"], [1, 1, "failed"], [2, 0, "passed"], [2, 1, "passed"]]);
    const artifacts = await getDb().artifact.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
    expect(artifacts.filter((a) => a.kind === "screenshot").map((a) => [a.attempt, a.name])).toEqual([[1, "step-2-failure"]]);
  });

  it("failing both attempts ends failed after exactly two", async () => {
    await start();
    const { runId } = await seedRun({ baseUrl: site.url, steps: alwaysFails });
    const run = await waitForStatus(runId, TERMINAL, 60_000);
    expect(run).toMatchObject({ status: "failed", passedAfterRetry: false, attemptCount: 2 });
    expect((await stepRows(runId)).map(([attempt, , status]) => `${attempt}:${status}`)).toEqual(["1:passed", "1:failed", "2:passed", "2:failed"]);
  });

  it("RUN_RETRY_ATTEMPTS=1 never retries", async () => {
    await start({ runAttempts: 1 });
    const { runId } = await seedRun({ baseUrl: site.url, steps: flaky() });
    expect(await waitForStatus(runId, TERMINAL, 60_000)).toMatchObject({ status: "failed", passedAfterRetry: false, attemptCount: 1 });
  });

  it("RUN_RETRY_ATTEMPTS=3 runs a failing scenario three times", async () => {
    await start({ runAttempts: 3 });
    const { runId } = await seedRun({ baseUrl: site.url, steps: alwaysFails });
    expect(await waitForStatus(runId, TERMINAL, 90_000)).toMatchObject({ status: "failed", passedAfterRetry: false, attemptCount: 3 });
    expect((await stepRows(runId)).map(([attempt, , status]) => `${attempt}:${status}`)).toEqual(["1:passed", "1:failed", "2:passed", "2:failed", "3:passed", "3:failed"]);
  });

  it("the scenario setting turns the retry off even with more attempts configured", async () => {
    await start({ runAttempts: 3 });
    const { runId } = await seedRun({ baseUrl: site.url, steps: flaky(), retryOnFailure: false });
    expect(await waitForStatus(runId, TERMINAL, 60_000)).toMatchObject({ status: "failed", attemptCount: 1 });
  });

  it("the scenario setting turns the retry off", async () => {
    await start();
    const { runId } = await seedRun({ baseUrl: site.url, steps: flaky(), retryOnFailure: false });
    const run = await waitForStatus(runId, TERMINAL, 60_000);
    expect(run).toMatchObject({ status: "failed", passedAfterRetry: false, attemptCount: 1 });
    expect(await getDb().stepResult.count({ where: { runId, attempt: 2 } })).toBe(0);
  });

  it("no retry after error", async () => {
    await start({ runArtifactBytes: 2_000 });
    const { runId } = await seedRun({ baseUrl: site.url, steps: [{ id: "s1", action: "goto", url: "/" }, { id: "s2", action: "screenshot", name: "big" }] });
    expect(await waitForStatus(runId, TERMINAL, 60_000)).toMatchObject({ status: "error", errorCode: "artifact_limit", attemptCount: 1 });
  });

  it("no retry after cancel", async () => {
    await start();
    const { runId, workspaceId } = await seedRun({ baseUrl: site.url, steps: [{ id: "s1", action: "goto", url: "/" }, { id: "s2", action: "waitForSelector", selector: "#never", timeout: 60_000 }] });
    await waitFor(() => getDb().stepResult.findFirst({ where: { runId, index: 0 } }));
    await requestCancel(getDb(), workspaceId, runId);
    expect(await waitForStatus(runId, TERMINAL, 15_000)).toMatchObject({ status: "cancelled", attemptCount: 1 });
  });

  it("no retry after timed_out", async () => {
    await start({ runTimeoutMs: 2_500 });
    const { runId } = await seedRun({ baseUrl: site.url, steps: [{ id: "s1", action: "goto", url: "/" }, { id: "s2", action: "waitForSelector", selector: "#never", timeout: 60_000 }] });
    expect(await waitForStatus(runId, TERMINAL, 15_000)).toMatchObject({ status: "timed_out", attemptCount: 1 });
  });

  it("losing the lease during attempt 2 ends error(worker_lost) with no further attempt", async () => {
    await start({ reapMs: 500 });
    const { runId } = await seedRun({ baseUrl: site.url, steps: flaky([{ id: "s3", action: "waitForSelector", selector: "#never", timeout: 60_000 }]) });
    await waitFor(() => getDb().stepResult.findFirst({ where: { runId, attempt: 2, index: 1 } }), 30_000);
    await getDb().$executeRaw`UPDATE "Run" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE id = ${runId}`;
    const run = await waitForStatus(runId, TERMINAL, 20_000);
    expect(run).toMatchObject({ status: "error", errorCode: "worker_lost", attemptCount: 2, passedAfterRetry: false });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await getDb().stepResult.count({ where: { runId, attempt: { gt: 2 } } })).toBe(0);
    expect((await getDb().run.findUniqueOrThrow({ where: { id: runId } })).attemptCount).toBe(2);
  });

  it("warnings are counted while the run stays passed, and do not trigger a retry", async () => {
    await start();
    const { runId } = await seedRun({
      baseUrl: site.url,
      steps: [{ id: "s1", action: "goto", url: "/" }, { id: "s2", action: "assertVisibleOrWarn", selector: "#missing", timeout: 500 }],
    });
    const run = await waitForStatus(runId, TERMINAL, 60_000);
    expect(run).toMatchObject({ status: "passed", warningCount: 1, attemptCount: 1, passedAfterRetry: false });
    expect(await stepRows(runId)).toEqual([[1, 0, "passed"], [1, 1, "warning"]]);
  });

  it("a group child counts with its final verdict, not the failed first attempt", async () => {
    await start();
    const g = await seedGroup({ size: 2, mode: "sequential", continueOnFailure: false, baseUrl: site.url, steps: flaky() });
    const group = await waitFor(async () => {
      const row = await getDb().groupRun.findUniqueOrThrow({ where: { id: g.groupRunId } });
      return row.finishedAt && row;
    }, 60_000);
    expect(group.status).toBe("passed");
    const runs = await getDb().run.findMany({ where: { groupRunId: g.groupRunId }, orderBy: { groupIndex: "asc" } });
    // Both children visit the same URL: the first fails once then passes, the second passes at once.
    expect(runs.map((r) => [r.status, r.attemptCount, r.passedAfterRetry])).toEqual([["passed", 2, true], ["passed", 1, false]]);
  });
});
