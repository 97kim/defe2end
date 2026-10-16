import { hostname } from "node:os";
import { parseRunAttempts, RUN_LIMITS } from "@defe2end/shared";
import { parseEncryptionKey } from "@defe2end/shared/server";

export function heartbeatIntervalMs(raw = process.env.HEARTBEAT_INTERVAL_MS): number {
  const ms = Number(raw ?? 10_000);
  if (!Number.isInteger(ms) || ms < 1_000) {
    throw new Error(`HEARTBEAT_INTERVAL_MS must be an integer >= 1000, got "${raw}"`);
  }
  return ms;
}

export interface WorkerConfig {
  workerId: string;
  heartbeatMs: number;
  leaseMs: number;
  pollMs: number;
  /** How often to read `cancelRequestedAt` of running runs, between heartbeats. */
  cancelPollMs: number;
  /** Longest wait for the claim lock; past it the round claims nothing, so shutdown isn't held up by it. */
  claimLockTimeoutMs: number;
  reapMs: number;
  /** Cleanup round: crash temp files, unregistered files, expired test runs. */
  maintenanceMs: number;
  /** Pre-save test runs are deleted this long after they end (contract section 7: 24 hours). */
  testRunKeepMs: number;
  /** Files younger than this are never treated as orphans: they may be between the move and the registration. */
  orphanAgeMs: number;
  /** Slack sender and daily report round (stage 5 contract section 5: every 5 seconds). */
  notifyMs: number;
  /** Schedule fire round (stage 5 contract section 4: every 15 seconds). */
  scheduleMs: number;
  concurrency: number;
  maxConcurrentRuns: number;
  workspaceConcurrency: number;
  runTimeoutMs: number;
  /** Whole-run attempts including the first (action spec 4.3); 1 = no retry. */
  runAttempts: number;
  minFreeDiskMb: number;
  runArtifactBytes: number;
  shutdownGraceMs: number;
  storageDir: string;
  blockPrivateNetworks: boolean;
  sandbox: boolean;
  encryptionKey: Buffer;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return value;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw !== "true" && raw !== "false") throw new Error(`${name} must be "true" or "false", got "${raw}"`);
  return raw === "true";
}

/** Reads the worker settings from the environment (stage 3 contract section 3 limits). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const heartbeatMs = heartbeatIntervalMs(env.HEARTBEAT_INTERVAL_MS);
  const leaseMs = int(env, "RUN_LEASE_MS", RUN_LIMITS.leaseMs, 2_000);
  if (leaseMs < heartbeatMs * 2) throw new Error("RUN_LEASE_MS must be at least twice HEARTBEAT_INTERVAL_MS");
  return {
    workerId: env.WORKER_ID || `${hostname()}-${process.pid}`,
    heartbeatMs,
    leaseMs,
    pollMs: int(env, "POLL_INTERVAL_MS", 1_000, 50),
    cancelPollMs: int(env, "CANCEL_POLL_INTERVAL_MS", 1_000, 50),
    claimLockTimeoutMs: int(env, "CLAIM_LOCK_TIMEOUT_MS", 3_000, 100),
    reapMs: 5_000,
    maintenanceMs: int(env, "MAINTENANCE_INTERVAL_MS", 10 * 60 * 1000, 1_000),
    testRunKeepMs: 24 * 60 * 60 * 1000,
    orphanAgeMs: 60 * 60 * 1000,
    notifyMs: 5_000,
    scheduleMs: 15_000,
    concurrency: int(env, "WORKER_CONCURRENCY", RUN_LIMITS.workerConcurrency, 1),
    maxConcurrentRuns: int(env, "MAX_CONCURRENT_RUNS", RUN_LIMITS.maxConcurrentRuns, 1),
    workspaceConcurrency: int(env, "WORKSPACE_CONCURRENCY", RUN_LIMITS.workspaceConcurrency, 1),
    runTimeoutMs: int(env, "RUN_TIMEOUT_MS", RUN_LIMITS.runTimeoutMs, 1_000),
    runAttempts: parseRunAttempts(env.RUN_RETRY_ATTEMPTS),
    minFreeDiskMb: int(env, "MIN_FREE_DISK_MB", RUN_LIMITS.minFreeDiskMb, 0),
    runArtifactBytes: RUN_LIMITS.runArtifactBytes,
    shutdownGraceMs: int(env, "SHUTDOWN_GRACE_MS", 30_000, 0),
    storageDir: env.STORAGE_DIR || "./data/storage",
    blockPrivateNetworks: bool(env, "BLOCK_PRIVATE_NETWORKS", false),
    // On by default; a host that can't provide it must turn it off explicitly (contract section 8).
    sandbox: bool(env, "CHROMIUM_SANDBOX", true),
    encryptionKey: parseEncryptionKey(env.DEFE2END_ENCRYPTION_KEY),
  };
}
