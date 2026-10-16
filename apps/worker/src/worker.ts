import { randomUUID } from "node:crypto";
import { claimNextRun, deleteExpiredApiIdempotency, deleteExpiredTestRuns, deletePrunableBaselineVersions, enqueueDueReports, finishRun, fireDueSchedules, scheduleFireDeps, findUnregisteredKeys, reapExpiredRuns, sendDueNotifications, settlePendingGroups, type PrismaClient } from "@defe2end/db";
import { RUNNER_VERSION, sweepBrowsers } from "@defe2end/runner";
import { IDEMPOTENCY } from "@defe2end/shared";
import { decryptSecret, LocalStorage } from "@defe2end/shared/server";
import type { WorkerConfig } from "./config.js";
import { executeRun, type RunHandle } from "./execute.js";

/** `<pid>.<random>`: the random part tells a restarted worker that reuses the pid (as in a container) from the old one. */
const OWNER = `${process.pid}.${randomUUID().slice(0, 8)}`;

function isStaleOwner(owner: string): boolean {
  if (owner === OWNER) return false;
  const pid = Number(owner.split(".")[0]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "EPERM";
  }
}

export interface Worker {
  /** Sweeps leftovers, reaps expired leases, then starts claiming. */
  start(): Promise<void>;
  /** SIGTERM: stop claiming, let running runs finish within the grace, then end them as `worker_shutdown`. */
  stop(): Promise<void>;
}

export function createWorker(db: PrismaClient, config: WorkerConfig): Worker {
  const storage = new LocalStorage(config.storageDir);
  const running = new Map<string, RunHandle>();
  let stopping = false;
  let claimTimer: NodeJS.Timeout | undefined;
  let reapTimer: NodeJS.Timeout | undefined;
  let maintenanceTimer: NodeJS.Timeout | undefined;
  let notifyTimer: NodeJS.Timeout | undefined;
  let scheduleTimer: NodeJS.Timeout | undefined;
  let claimLoop: Promise<void> | undefined;
  let diskWarned = false;

  const reap = async () => {
    try {
      const ids = await reapExpiredRuns(db);
      for (const id of ids) console.log(`run ${id}: lease expired, ended as error(worker_lost)`);
      await settlePendingGroups(db);
    } catch (err) {
      console.error("reaper failed", (err as Error).message);
    }
  };

  let maintaining = false;
  const maintain = async () => {
    if (maintaining) return;
    maintaining = true;
    try {
      const result = await runMaintenance(db, storage, config);
      if (result.testRuns || result.baselineVersions || result.orphans || result.temp) {
        console.log(`cleanup: ${result.testRuns} expired test runs, ${result.baselineVersions} old baseline versions, ${result.orphans} unregistered files, ${result.temp} temporary files removed`);
      }
    } catch (err) {
      console.error("cleanup failed", (err as Error).message);
    } finally {
      maintaining = false;
    }
  };

  // Slack (stage 5 contract sections 5 and 6): due daily reports, then due deliveries. One round at a time per
  // worker; across workers the sender lock lets one claim per round and the report row lock makes each window once.
  let notifying: Promise<void> | undefined;
  const notify = () => {
    notifying ??= (async () => {
      try {
        await enqueueDueReports(db);
        await sendDueNotifications(db, { decrypt: (c) => decryptSecret(c, config.encryptionKey) });
      } catch (err) {
        console.error("notification round failed", (err as Error).message);
      }
    })().finally(() => (notifying = undefined));
    return notifying;
  };

  // Schedules (stage 5 contract section 4): one round at a time per worker; across workers the scheduler lock
  // picks one leader per round and each schedule's row lock and unique fire key keep a fire single.
  const fireDeps = scheduleFireDeps({ freeBytes: () => storage.freeBytes(), minFreeBytes: () => config.minFreeDiskMb * 1024 * 1024 });
  let firing: Promise<void> | undefined;
  const fireSchedules = () => {
    firing ??= (async () => {
      try {
        for (const result of await fireDueSchedules(db, fireDeps)) {
          for (const fire of result.fires) console.log(`schedule ${result.scheduleId}: ${fire.status}${fire.reasonCode ? `(${fire.reasonCode})` : ""}`);
        }
      } catch (err) {
        console.error("schedule round failed", (err as Error).message);
      }
    })().finally(() => (firing = undefined));
    return firing;
  };

  // stop() waits for this loop too: a claim already sent may still return a run after shutdown began.
  const claimAll = () => {
    if (claimLoop || stopping) return claimLoop;
    claimLoop = claimRuns().finally(() => (claimLoop = undefined));
    return claimLoop;
  };

  const claimRuns = async () => {
    try {
      while (!stopping && running.size < config.concurrency) {
        const freeMb = (await storage.freeBytes()) / 1024 / 1024;
        if (freeMb < config.minFreeDiskMb) {
          if (!diskWarned) console.warn(`only ${Math.round(freeMb)} MB free in ${config.storageDir}; not claiming runs`);
          diskWarned = true;
          return;
        }
        diskWarned = false;
        const claimSentAt = Date.now();
        const claimed = await claimNextRun(db, {
          workerId: config.workerId,
          runnerVersion: RUNNER_VERSION,
          leaseMs: config.leaseMs,
          maxConcurrentRuns: config.maxConcurrentRuns,
          workspaceConcurrency: config.workspaceConcurrency,
          lockTimeoutMs: config.claimLockTimeoutMs,
        });
        if (!claimed) return;
        if (stopping) {
          // Claimed after shutdown began: never start a browser, and never re-queue (no automatic re-run).
          await finishRun(db, claimed.id, claimed.claimToken, { status: "error", errorCode: "worker_shutdown", errorMessage: "The worker shut down before this run started." });
          console.log(`run ${claimed.id}: claimed during shutdown, ended as error(worker_shutdown)`);
          return;
        }
        console.log(`run ${claimed.id}: claimed`);
        const handle = executeRun({ db, storage, config, owner: OWNER }, claimed, claimSentAt);
        running.set(claimed.id, handle);
        void handle.done.finally(() => running.delete(claimed.id));
      }
    } catch (err) {
      console.error("claim failed", (err as Error).message);
    }
  };

  return {
    async start() {
      const swept = await sweepBrowsers(isStaleOwner).catch((err: Error) => {
        console.error("browser sweep failed", err.message);
        return [];
      });
      if (swept.length) console.log(`killed leftover browsers of runs ${swept.join(", ")}`);
      await reap();
      await maintain();
      reapTimer = setInterval(() => void reap(), config.reapMs);
      maintenanceTimer = setInterval(() => void maintain(), config.maintenanceMs);
      claimTimer = setInterval(() => void claimAll(), config.pollMs);
      notifyTimer = setInterval(() => void notify(), config.notifyMs);
      scheduleTimer = setInterval(() => void fireSchedules(), config.scheduleMs);
      void fireSchedules();
      void claimAll();
    },

    async stop() {
      stopping = true;
      clearInterval(claimTimer);
      await claimLoop;
      const all = () => Promise.all([...running.values()].map((h) => h.done));
      const finished = await Promise.race([all().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), config.shutdownGraceMs))]);
      if (!finished) {
        for (const handle of running.values()) handle.stop("worker_shutdown");
        await all();
      }
      clearInterval(reapTimer);
      clearInterval(maintenanceTimer);
      clearInterval(notifyTimer);
      clearInterval(scheduleTimer);
      await Promise.all([notifying, firing]);
    },
  };
}

/**
 * One cleanup round (contract section 7): expired test runs with their files, files no row refers to (a crash
 * between the move and the registration, a refused registration, a deleted workspace), and temp files a crash
 * left. Deleting is idempotent, so several workers doing it at once only repeat work.
 */
export async function runMaintenance(db: PrismaClient, storage: LocalStorage, config: Pick<WorkerConfig, "testRunKeepMs" | "orphanAgeMs">) {
  let testRuns = 0;
  for (;;) {
    const { runIds, storageKeys } = await deleteExpiredTestRuns(db, config.testRunKeepMs);
    for (const key of storageKeys) await storage.delete(key);
    testRuns += runIds.length;
    if (runIds.length === 0) break;
  }
  let baselineVersions = 0;
  for (;;) {
    const { versionIds, storageKeys } = await deletePrunableBaselineVersions(db);
    for (const key of storageKeys) await storage.delete(key);
    baselineVersions += versionIds.length;
    if (versionIds.length === 0) break;
  }
  let orphans = 0;
  const cutoff = Date.now() - config.orphanAgeMs;
  let batch: string[] = [];
  const flush = async () => {
    for (const key of await findUnregisteredKeys(db, batch)) {
      await storage.delete(key);
      orphans++;
    }
    batch = [];
  };
  for await (const file of storage.list("workspaces/")) {
    if (file.modifiedAt.getTime() > cutoff) continue;
    batch.push(file.key);
    if (batch.length >= 500) await flush();
  }
  await flush();
  const temp = await storage.cleanupTemp(config.orphanAgeMs);
  await deleteExpiredApiIdempotency(db, IDEMPOTENCY.ttlMs);
  return { testRuns, baselineVersions, orphans, temp };
}
