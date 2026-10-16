import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient, type PrismaClient } from "@defe2end/db";
import { DEFAULT_DEVICE, type RunSnapshot, type Step } from "@defe2end/shared";
import { encryptSecret, parseEncryptionKey } from "@defe2end/shared/server";
import { describe } from "vitest";
import { loadConfig, type WorkerConfig } from "../src/config.js";

/** Use instead of `describe` for tests that need Postgres; skipped when TEST_DATABASE_URL is unset (never in CI). */
export const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

let client: PrismaClient | undefined;
export function getDb(): PrismaClient {
  return (client ??= createDbClient());
}

export async function resetDatabase(): Promise<void> {
  const db = getDb();
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

/** Fast timers so lease and cancel paths finish in seconds. */
export async function testConfig(overrides: Partial<WorkerConfig> = {}): Promise<WorkerConfig> {
  return {
    ...loadConfig({ ...process.env, HEARTBEAT_INTERVAL_MS: "1000", RUN_LEASE_MS: "6000", POLL_INTERVAL_MS: "100", CANCEL_POLL_INTERVAL_MS: "200", MIN_FREE_DISK_MB: "0" }),
    storageDir: await mkdtemp(join(tmpdir(), "defe2end-worker-")),
    sandbox: process.env.CHROMIUM_SANDBOX !== "false",
    ...overrides,
  };
}

let counter = 0;

/** A workspace with one site, environment and scenario, plus a queued run of `steps`. */
export async function seedRun(opts: {
  baseUrl: string;
  steps: Step[];
  variables?: { key: string; value: string; secret?: boolean }[];
  workspaceId?: string;
  retryOnFailure?: boolean;
  attachments?: RunSnapshot["attachments"];
}) {
  const db = getDb();
  const n = ++counter;
  const workspace = opts.workspaceId ? { id: opts.workspaceId } : await db.workspace.create({ data: { name: `ws ${n}`, slug: `ws-${n}-${Date.now()}` } });
  const site = await db.site.create({ data: { workspaceId: workspace.id, name: `site ${n}` } });
  const environment = await db.environment.create({ data: { workspaceId: workspace.id, siteId: site.id, name: "Local", baseUrl: opts.baseUrl } });
  const key = parseEncryptionKey(process.env.DEFE2END_ENCRYPTION_KEY);
  for (const v of opts.variables ?? []) {
    await db.variable.create({
      data: {
        workspaceId: workspace.id,
        environmentId: environment.id,
        key: v.key,
        isSecret: v.secret ?? false,
        value: v.secret ? null : v.value,
        valueEncrypted: v.secret ? encryptSecret(v.value, key) : null,
      },
    });
  }
  const scenario = await db.scenario.create({ data: { workspaceId: workspace.id, siteId: site.id, name: `scenario ${n}`, steps: opts.steps, retryOnFailure: opts.retryOnFailure ?? true } });
  const snapshot: RunSnapshot = {
    scenario: { id: scenario.id, name: scenario.name, stepFormatVersion: 1, steps: opts.steps, retryOnFailure: scenario.retryOnFailure },
    environment: { id: environment.id, name: environment.name, baseUrl: environment.baseUrl },
    device: DEFAULT_DEVICE,
    variableKeys: (opts.variables ?? []).map((v) => v.key),
    attachments: opts.attachments ?? [],
  };
  const run = await db.run.create({
    data: { workspaceId: workspace.id, scenarioId: scenario.id, environmentId: environment.id, trigger: "manual", snapshot },
  });
  return { workspaceId: workspace.id, runId: run.id };
}

export async function waitFor<T>(read: () => Promise<T | undefined | null | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function waitForStatus(runId: string, statuses: string[], timeoutMs?: number) {
  return waitFor(async () => {
    const run = await getDb().run.findUniqueOrThrow({ where: { id: runId } });
    return statuses.includes(run.status) && run;
  }, timeoutMs);
}

export const CLAIM = { workerId: "test-worker", runnerVersion: "0.0.0", leaseMs: 30_000, maxConcurrentRuns: 100, workspaceConcurrency: 100 };

/** A group of `size` children (scenarios of one site) in a fresh workspace, created like the web app does. */
export async function seedGroup(opts: { size: number; mode: "sequential" | "parallel"; continueOnFailure: boolean; baseUrl?: string; steps?: Step[]; retryOnFailure?: boolean }) {
  const db = getDb();
  const steps = opts.steps ?? [{ id: "s1", action: "goto" as const, url: "/" }];
  const first = await seedRun({ baseUrl: opts.baseUrl ?? "http://127.0.0.1:9", steps, retryOnFailure: opts.retryOnFailure });
  const template = await db.run.findUniqueOrThrow({ where: { id: first.runId } });
  await db.run.delete({ where: { id: first.runId } });
  const group = await db.groupRun.create({
    data: { workspaceId: first.workspaceId, environmentId: template.environmentId, mode: opts.mode, continueOnFailure: opts.continueOnFailure },
  });
  const runIds: string[] = [];
  for (let i = 0; i < opts.size; i++) {
    const run = await db.run.create({
      data: { workspaceId: first.workspaceId, scenarioId: template.scenarioId, environmentId: template.environmentId, groupRunId: group.id, groupIndex: i, trigger: "manual", snapshot: template.snapshot as object, queuedAt: template.queuedAt },
    });
    runIds.push(run.id);
  }
  return { workspaceId: first.workspaceId, groupRunId: group.id, runIds };
}
