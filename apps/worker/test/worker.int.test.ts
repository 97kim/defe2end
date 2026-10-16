// Whole runs through the worker: real Postgres + fixture server + real Chromium (stage 3 contract sections 0 and 9).
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimNextRun, RUN_CLAIM_LOCK } from "@defe2end/db";
import { listMarkedBrowsers } from "@defe2end/runner";
import type { Step } from "@defe2end/shared";
import { attachmentKey, LocalStorage } from "@defe2end/shared/server";
import { startFixtureServer, type FixtureServer } from "@defe2end/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../src/config.js";
import { createWorker, type Worker } from "../src/worker.js";
import { CLAIM, describeDb, getDb, resetDatabase, seedRun, testConfig, waitFor, waitForStatus } from "./helpers.js";

const SECRET = "s3cret-value-never-stored";

describeDb("worker runs", () => {
  let fixtures: FixtureServer;
  let worker: Worker | undefined;
  let config: WorkerConfig;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });
  afterAll(() => fixtures.close());
  beforeEach(resetDatabase);
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
  });

  async function start(overrides: Partial<WorkerConfig> = {}) {
    config = await testConfig(overrides);
    worker = createWorker(getDb(), config);
    await worker.start();
  }

  const steps = (rows: Step[]) => rows;

  it("a passing run stores every step, its screenshot and the verdict", async () => {
    await start();
    const { runId } = await seedRun({
      baseUrl: fixtures.url,
      steps: steps([
        { id: "s1", action: "goto", url: "/login.html" },
        { id: "s2", action: "fill", selector: "[data-testid=username]", value: "{{USER}}" },
        { id: "s3", action: "fill", selector: "[data-testid=password]", value: "{{PASSWORD}}" },
        { id: "s4", action: "click", selector: "[data-testid=login-submit]" },
        { id: "s5", action: "assertText", selector: "h1", expected: "Products" },
        { id: "s6", action: "screenshot", name: "products" },
      ]),
      variables: [{ key: "USER", value: "tester" }, { key: "PASSWORD", value: "correct-horse", secret: true }],
    });
    const run = await waitForStatus(runId, ["passed", "failed", "error"]);
    expect(run).toMatchObject({ status: "passed", errorCode: null, workerId: config.workerId });
    expect(run.variablesResolvedAt).toBeInstanceOf(Date);
    expect(run.browserVersion).toMatch(/^\d+\./);
    const results = await getDb().stepResult.findMany({ where: { runId }, orderBy: { index: "asc" } });
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "passed", "passed", "passed"]);
    const [artifact] = await getDb().artifact.findMany({ where: { runId } });
    expect(artifact).toMatchObject({ kind: "screenshot", stepIndex: 5, name: "products", contentType: "image/png" });
    const file = await readFile(join(config.storageDir, artifact!.storageKey));
    expect(file.length).toBe(artifact!.sizeBytes);
  });

  it("uploads the attachment version pinned in the snapshot, mixed with a URL, even after a newer version", async () => {
    await start();
    const storage = new LocalStorage(config.storageDir);
    const workspace = await getDb().workspace.create({ data: { name: "ws attach", slug: `ws-attach-${Date.now()}` } });
    const store = async (version: number, body: string) => {
      const storageKey = attachmentKey(workspace.id);
      const { sizeBytes } = await storage.put(storageKey, Readable.from([Buffer.from(body)]));
      return getDb().attachment.create({ data: { workspaceId: workspace.id, name: "my photo.png", version, storageKey, contentType: "image/png", sizeBytes } });
    };
    const v1 = await store(1, "first");
    await store(2, "second-version");
    const { runId } = await seedRun({
      workspaceId: workspace.id,
      baseUrl: fixtures.url,
      steps: steps([
        { id: "s1", action: "goto", url: "/actions.html" },
        { id: "s2", action: "uploadFile", selector: "#file", value: "attachment:my%20photo.png" },
        { id: "s3", action: "assertText", selector: "#file-name", expected: "my photo.png:5" },
        { id: "s4", action: "goto", url: "/parity.html" },
        { id: "s5", action: "uploadFile", selector: "#file", value: `attachment:my%20photo.png ${fixtures.url}/style.css` },
        { id: "s6", action: "assertTitle", expected: "my photo.png:image/png,style.css:text/css" },
      ]),
      attachments: [{ name: "my photo.png", id: v1.id, version: 1 }],
    });
    const run = await waitForStatus(runId, ["passed", "failed", "error"]);
    const results = await getDb().stepResult.findMany({ where: { runId }, orderBy: { index: "asc" } });
    expect(results.map((r) => [r.status, r.errorMessage])).toEqual(Array(6).fill(["passed", null]));
    expect(run.status).toBe("passed");
  });

  it("an attachment token not pinned in the snapshot fails the step", async () => {
    await start();
    const { runId } = await seedRun({
      baseUrl: fixtures.url,
      steps: steps([
        { id: "s1", action: "goto", url: "/actions.html" },
        { id: "s2", action: "uploadFile", selector: "#file", value: "attachment:missing.png" },
      ]),
      retryOnFailure: false,
    });
    expect(await waitForStatus(runId, ["passed", "failed", "error"])).toMatchObject({ status: "failed" });
    const step = await getDb().stepResult.findFirst({ where: { runId, index: 1 } });
    expect(step).toMatchObject({ status: "failed", errorCode: "invalid_step" });
  });

  it("an assertion failure ends failed; the secret appears in no row, file or log", async () => {
    const output: string[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(" ")));
    }
    await start();
    const { runId } = await seedRun({
      baseUrl: fixtures.url,
      steps: steps([
        { id: "s1", action: "goto", url: "/login.html" },
        { id: "s2", action: "fill", selector: "[data-testid=username]", value: "{{TOKEN}}" },
        { id: "s3", action: "assertText", selector: "h1", expected: "Hello {{TOKEN}}", timeout: 500 },
        { id: "s4", action: "goto", url: "http://169.254.169.254/{{TOKEN}}" },
      ]),
      variables: [{ key: "TOKEN", value: SECRET, secret: true }],
      retryOnFailure: false,
    });
    const run = await waitForStatus(runId, ["passed", "failed", "error"]);
    vi.restoreAllMocks();
    expect(run.status).toBe("failed");
    const results = await getDb().stepResult.findMany({ where: { runId }, orderBy: { index: "asc" } });
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "failed", "skipped"]);
    expect(results[2]).toMatchObject({ errorCode: "assertion_failed", expected: "Hello ••••••", actual: "Log in" });

    const artifacts = await getDb().artifact.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
    expect(artifacts.map((a) => [a.kind, a.name]).sort()).toEqual([
      ["dom_summary", "step-3-dom"],
      ["screenshot", "step-3-failure"],
    ]);
    const rows = JSON.stringify(
      await Promise.all([getDb().run.findMany(), getDb().stepResult.findMany(), getDb().artifact.findMany(), getDb().variable.findMany()]),
    );
    expect(rows).not.toContain(SECRET);
    expect(output.join("\n")).not.toContain(SECRET);
    for (const a of artifacts) expect((await readFile(join(config.storageDir, a.storageKey))).includes(SECRET)).toBe(false);
  });

  it("a metadata address is blocked and logged", async () => {
    await start();
    const { runId } = await seedRun({
      baseUrl: fixtures.url,
      steps: steps([{ id: "s1", action: "goto", url: "/network.html" }, { id: "s2", action: "goto", url: "http://0xa9fea9fe/latest/" }]),
      retryOnFailure: false,
    });
    const run = await waitForStatus(runId, ["passed", "failed", "error"]);
    expect(run.status).toBe("failed");
    const results = await getDb().stepResult.findMany({ where: { runId }, orderBy: { index: "asc" } });
    expect(results[1]).toMatchObject({ status: "failed", errorCode: "blocked_request" });
    const log = (await getDb().artifact.findFirst({ where: { runId, kind: "log", name: "run.log" } }))!;
    expect(await readFile(join(config.storageDir, log.storageKey), "utf8")).toContain("Blocked request to http://169.254.169.254/latest/meta-data/");
    // The page's own blocked requests go into that step's browser log.
    const browserLog = (await getDb().artifact.findFirst({ where: { runId, kind: "log", name: "step-1-console" } }))!;
    expect(browserLog.stepIndex).toBe(0);
    expect(await readFile(join(config.storageDir, browserLog.storageKey), "utf8")).toContain("request failed: GET http://169.254.169.254/latest/meta-data/");
  });

  it("cancel while running: requested first, then cancelled with the browser gone", async () => {
    await start();
    const { runId, workspaceId } = await seedRun({
      baseUrl: fixtures.url,
      steps: steps([
        { id: "s1", action: "goto", url: "/" },
        { id: "s2", action: "waitForSelector", selector: "#never", timeout: 60_000 },
        { id: "s3", action: "click", selector: "a" },
      ]),
    });
    await waitFor(() => getDb().stepResult.findFirst({ where: { runId, index: 0 } }));
    const { requestCancel } = await import("@defe2end/db");
    const requested = await requestCancel(getDb(), workspaceId, runId);
    expect(requested?.status).toBe("running");
    const run = await waitForStatus(runId, ["cancelled", "passed", "failed", "error"], 15_000);
    expect(run.status).toBe("cancelled");
    const results = await getDb().stepResult.findMany({ where: { runId }, orderBy: { index: "asc" } });
    expect(results.map((r) => r.status)).toEqual(["passed", "cancelled", "skipped"]);
    expect((await listMarkedBrowsers()).filter((p) => p.runId === runId)).toEqual([]);
  });

  it("a claim still in flight when stop() is called ends its run as error(worker_shutdown) without a browser", async () => {
    const { runId } = await seedRun({ baseUrl: fixtures.url, steps: steps([{ id: "s1", action: "goto", url: "/" }]) });
    // Hold the claim lock so the worker's claim blocks inside the DB until we let go.
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = getDb().$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_CLAIM_LOCK}::bigint)`;
        locked();
        await new Promise<void>((r) => (release = r));
      },
      { timeout: 60_000 },
    );
    await isLocked;
    await start({ claimLockTimeoutMs: 60_000 });
    await waitFor(async () => {
      const [row] = await getDb().$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND objid = ${RUN_CLAIM_LOCK}::bigint::oid AND NOT granted`;
      return (row?.waiting ?? 0) > 0;
    });
    let stopped = false;
    const stopping = worker!.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 500));
    expect(stopped).toBe(false); // waits for the claim in flight
    release();
    await holder;
    await stopping;
    worker = undefined;
    const run = await getDb().run.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: "error", errorCode: "worker_shutdown", leaseExpiresAt: null });
    expect(await getDb().stepResult.count({ where: { runId } })).toBe(0);
    expect((await listMarkedBrowsers()).filter((p) => p.runId === runId)).toEqual([]);
  });

  it("a claim gives up on a held claim lock within its bound, so stop() isn't held up by it", async () => {
    const { runId } = await seedRun({ baseUrl: fixtures.url, steps: steps([{ id: "s1", action: "goto", url: "/" }]) });
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = getDb().$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_CLAIM_LOCK}::bigint)`;
        locked();
        await new Promise<void>((r) => (release = r));
      },
      { timeout: 60_000 },
    );
    await isLocked;
    try {
      const sentAt = Date.now();
      expect(await claimNextRun(getDb(), { ...CLAIM, lockTimeoutMs: 300 })).toBeNull();
      expect(Date.now() - sentAt).toBeLessThan(3_000);

      await start({ claimLockTimeoutMs: 500, shutdownGraceMs: 2_000 });
      await waitFor(async () => {
        const [row] = await getDb().$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND objid = ${RUN_CLAIM_LOCK}::bigint::oid AND NOT granted`;
        return (row?.waiting ?? 0) > 0;
      });
      const stopAt = Date.now();
      await worker!.stop(); // the lock is still held
      worker = undefined;
      expect(Date.now() - stopAt).toBeLessThan(config.shutdownGraceMs);
      expect(await getDb().run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: "queued" });
    } finally {
      release();
      await holder;
    }
  });

  it("the overall timeout ends the run as timed_out", async () => {
    await start({ runTimeoutMs: 2_500 });
    const { runId } = await seedRun({
      baseUrl: fixtures.url,
      steps: steps([
        { id: "s1", action: "goto", url: "/" },
        { id: "s2", action: "waitForSelector", selector: "#never", timeout: 60_000 },
      ]),
    });
    const run = await waitForStatus(runId, ["timed_out", "passed", "failed", "error"], 15_000);
    expect([run.status, run.errorCode, run.errorMessage]).toEqual(["timed_out", null, null]);
    const results = await getDb().stepResult.findMany({ where: { runId }, orderBy: { index: "asc" } });
    expect(results.map((r) => r.status)).toEqual(["passed", "timed_out"]);
  });
});

describeDb("worker killed with SIGKILL", () => {
  let fixtures: FixtureServer;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    await resetDatabase();
  });
  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
    await fixtures.close();
  });

  async function spawnWorker(storageDir: string) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/main.js", import.meta.url))], {
      env: {
        ...process.env,
        HEARTBEAT_INTERVAL_MS: "1000",
        RUN_LEASE_MS: "5000",
        POLL_INTERVAL_MS: "100",
        MIN_FREE_DISK_MB: "0",
        STORAGE_DIR: storageDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    return { child, output: () => output };
  }

  it("ends the run as error(worker_lost) after the lease, never re-runs it, and leaves no browser", async () => {
    const { storageDir } = await testConfig();
    const { runId } = await seedRun({
      baseUrl: fixtures.url,
      steps: [
        { id: "s1", action: "goto", url: "/" },
        { id: "s2", action: "waitForSelector", selector: "#never", timeout: 120_000 },
      ],
    });
    const first = await spawnWorker(storageDir);
    await waitFor(() => getDb().stepResult.findFirst({ where: { runId, index: 0 } }), 30_000);
    const browsers = await waitFor(async () => {
      const found = (await listMarkedBrowsers()).filter((p) => p.runId === runId);
      return found.length > 0 && found;
    });
    const claimed = await getDb().run.findUniqueOrThrow({ where: { id: runId } });
    expect(claimed.status).toBe("running");

    first.child.kill("SIGKILL");
    await new Promise((r) => first.child.once("exit", r));

    // A restarted worker sweeps the dead worker's browsers and reaps the expired lease.
    const second = await spawnWorker(storageDir);
    const run = await waitForStatus(runId, ["error", "passed", "failed", "cancelled", "timed_out"], 20_000);
    expect(run).toMatchObject({ status: "error", errorCode: "worker_lost", claimToken: claimed.claimToken });
    expect(run.startedAt).toEqual(claimed.startedAt); // not claimed again
    await new Promise((r) => setTimeout(r, 1_000));
    expect((await getDb().run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("error");

    expect((await listMarkedBrowsers()).filter((p) => p.runId === runId)).toEqual([]);
    for (const b of browsers) {
      expect(() => process.kill(-b.pgid, 0)).toThrow();
    }
    second.child.kill("SIGTERM");
    await new Promise((r) => second.child.once("exit", r));
    expect(second.output()).toContain("ended as error(worker_lost)");
  });
});
