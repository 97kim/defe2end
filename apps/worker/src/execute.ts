import { finishRun, heartbeat, resolveRunVariables, subjectAuthSession, subjectOfRun, VARIABLE_MISSING_MESSAGE, markVariablesResolved, recordStepResult, startAttempt, type ClaimedRun, type PrismaClient } from "@defe2end/db";
import { runPlan, runWithRetries, type RunPlanOptions, type UploadFile } from "@defe2end/runner";
import { ArtifactLimitError, maskSecrets, storageStateSchema, runOptionsSchema, runSnapshotSchema, RUN_LIMITS, type AbortReason, type ArtifactSink, type ExecutionPlan, type RunVerdict } from "@defe2end/shared";
import { decryptSecret, type StorageDriver } from "@defe2end/shared/server";
import type { WorkerConfig } from "./config.js";
import { storageSink } from "./sink.js";

export interface ExecuteDeps {
  db: PrismaClient;
  storage: StorageDriver;
  config: WorkerConfig;
  /** Marks this worker's browsers for the startup sweep. */
  owner: string;
}

/** Stop this run from outside (worker shutdown). */
export type RunHandle = { done: Promise<void>; stop(reason: AbortReason): void };

/**
 * Runs one claimed run to the end. Heartbeat, cancel polling and the overall timeout are timers independent
 * of the step loop; any of them stops the browser through the abort signal. Every write is ownership-checked:
 * once the lease is lost nothing more is stored, and the reaper ends the run as `error(worker_lost)`.
 */
/** `claimSentAt`: local time the claim was sent; the lease the DB granted ends no earlier than this + leaseMs. */
export function executeRun(deps: ExecuteDeps, claimed: ClaimedRun, claimSentAt: number): RunHandle {
  const controller = new AbortController();
  const stop = (reason: AbortReason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  return { done: execute(deps, claimed, claimSentAt, controller.signal, stop), stop };
}

async function execute(deps: ExecuteDeps, claimed: ClaimedRun, claimSentAt: number, signal: AbortSignal, stop: (reason: AbortReason) => void): Promise<void> {
  const { db, config } = deps;
  const { id: runId, claimToken } = claimed;
  let secrets: string[] = [];
  const log = (message: string) => console.log(`run ${runId}: ${maskSecrets(message, secrets)}`);

  // Lease: stop before the last confirmed expiry (measured from when the renewal was sent) if renewals fail.
  const margin = Math.min(1_000, config.heartbeatMs / 2);
  let leaseTimer = setTimeout(() => stop("worker_lost"), claimSentAt + config.leaseMs - margin - Date.now());
  const beat = async () => {
    const sentAt = Date.now();
    try {
      const result = await heartbeat(db, runId, claimToken, config.leaseMs);
      if (!result.owned) return stop("worker_lost");
      clearTimeout(leaseTimer);
      leaseTimer = setTimeout(() => stop("worker_lost"), sentAt + config.leaseMs - margin - Date.now());
      if (result.cancelRequested) stop("cancelled");
    } catch (err) {
      log(`heartbeat failed: ${(err as Error).message}`);
    }
  };
  const heartbeatTimer = setInterval(() => void beat(), config.heartbeatMs);
  const cancelTimer = setInterval(() => {
    db.run
      .findUnique({ where: { id: runId }, select: { cancelRequestedAt: true } })
      .then((row) => row?.cancelRequestedAt && stop("cancelled"))
      .catch(() => {});
  }, config.cancelPollMs);

  let verdict: RunVerdict;
  let passedAfterRetry = false;
  let attempt = 0;
  try {
    const plan = await buildPlan(deps, claimed);
    secrets = Object.values(plan.variables).flatMap((v) => (v.secret && v.value ? [v.value] : []));
    if (!(await markVariablesResolved(db, runId, claimToken))) stop("worker_lost");

    // One sink for the whole run: the artifact size limit counts every attempt.
    const sink = storageSink({ db, storage: deps.storage, run: { id: runId, workspaceId: claimed.workspaceId, claimToken }, attempt: () => attempt, limitBytes: config.runArtifactBytes, onLeaseLost: () => stop("worker_lost") });
    // Whole-run retry (action spec 4.3): up to `config.runAttempts` attempts. The run stays `running` in between,
    // so heartbeat and cancel polling above keep covering every attempt, and a group sees only the final verdict.
    // Overall time counts from the claim (`startedAt`), retries and waits included (contract section 3).
    const retried = await runWithRetries({
      policy: { maxAttempts: config.runAttempts, retryOnFailure: runSnapshotSchema.parse(claimed.snapshot).scenario.retryOnFailure, runTimeoutMs: config.runTimeoutMs },
      startedAt: claimSentAt,
      signal,
      stop,
      runAttempt: async (n) => {
        attempt = n;
        if (!(await startAttempt(db, runId, claimToken, attempt))) {
          stop("worker_lost");
          return { status: "error", errorCode: "worker_lost", errorMessage: "The run's lease was lost", warningCount: 0 };
        }
        return runAttempt(deps, claimed, { ...plan, attempt }, sink, signal, stop, log);
      },
      onRetry: (next) => log(`attempt ${next - 1} failed; retrying the whole run`),
    });
    verdict = retried.verdict;
    passedAfterRetry = retried.passedAfterRetry;
  } catch (err) {
    verdict =
      err instanceof AuthSessionMissingError
        ? { status: "error", errorCode: "auth_session_missing", errorMessage: err.message, warningCount: 0 }
        : err instanceof VariableMissingError
        ? { status: "error", errorCode: "variable_missing", errorMessage: err.message, warningCount: 0 }
        : err instanceof ArtifactLimitError
        ? { status: "error", errorCode: "artifact_limit", errorMessage: err.message, warningCount: 0 }
        : { status: "error", errorCode: "internal", errorMessage: maskSecrets((err as Error).message, secrets), warningCount: 0 };
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(cancelTimer);
    clearTimeout(leaseTimer);
  }

  try {
    const stored = await finishRun(db, runId, claimToken, { ...verdict, passedAfterRetry });
    log(stored ? `finished: ${verdict.status}` : `lease lost, verdict ${verdict.status} discarded`);
  } catch (err) {
    log(`verdict not stored: ${(err as Error).message}`);
  }
}

/** One pass over the steps. Step results and artifacts carry the attempt number; the log is one file per attempt. */
async function runAttempt(
  deps: ExecuteDeps,
  claimed: ClaimedRun,
  plan: ExecutionPlan,
  sink: ArtifactSink,
  signal: AbortSignal,
  stop: (reason: AbortReason) => void,
  log: (message: string) => void,
): Promise<RunVerdict> {
  const { db } = deps;
  const { id: runId, claimToken } = claimed;
  const attempt = plan.attempt ?? 1;
  const logLines: string[] = [];
  const runOptions: RunPlanOptions = {
    sink,
    signal,
    owner: deps.owner,
    sandbox: deps.config.sandbox,
    resolveAttachment: attachmentResolver(deps, claimed),
    ...(runSnapshotSchema.parse(claimed.snapshot).masking ? { masking: runSnapshotSchema.parse(claimed.snapshot).masking } : {}),
    onEvent: async (event) => {
      if (event.type === "log") logLines.push(`${event.stepIndex === undefined ? "" : `[step ${event.stepIndex + 1}] `}${event.level}: ${event.message}`);
      if (event.type !== "stepFinished") return;
      // `name` and `retried` are display-only (snapshot step name; attempts > 1).
      const { name: _name, retried: _retried, ...result } = event.result;
      try {
        // Step results are written in order; a refused write means the lease is gone.
        if (!(await recordStepResult(db, runId, claimToken, { ...result, attempt }))) stop("worker_lost");
      } catch (err) {
        log(`step result not stored: ${(err as Error).message}`);
        stop("worker_lost");
      }
    },
  };
  const verdict = await runPlan(plan, runOptions);
  if (logLines.length > 0) {
    const writer = await sink.open({ kind: "log", name: attempt === 1 ? "run.log" : `run.attempt-${attempt}.log` });
    try {
      await writer.write(new TextEncoder().encode(`${logLines.join("\n")}\n`));
    } catch (err) {
      await writer.abort((err as Error).message);
      throw err;
    }
    await writer.complete();
  }
  return verdict;
}

/**
 * `attachment:<name>` uploadFile tokens → the version pinned in the snapshot at request time (never a newer
 * one uploaded since). A name not pinned, or a version gone, fails the step. Files are read once per run.
 */
function attachmentResolver(deps: ExecuteDeps, claimed: ClaimedRun): RunPlanOptions["resolveAttachment"] {
  const pinned = new Map(runSnapshotSchema.parse(claimed.snapshot).attachments.map((a) => [a.name, a]));
  const cache = new Map<string, Promise<UploadFile | undefined>>();
  const load = async (id: string): Promise<UploadFile | undefined> => {
    const row = await deps.db.attachment.findFirst({ where: { id, workspaceId: claimed.workspaceId } });
    if (!row) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of await deps.storage.get(row.storageKey)) chunks.push(Buffer.from(chunk as Uint8Array));
    return { name: row.name, mimeType: row.contentType, buffer: Buffer.concat(chunks) };
  };
  return (name) => {
    const pin = pinned.get(name);
    if (!pin) return Promise.resolve(undefined);
    let file = cache.get(pin.id);
    if (!file) {
      file = load(pin.id);
      cache.set(pin.id, file);
    }
    return file;
  };
}

/** The snapshot fixed at request time + variable values read now (contract section 2). Never stored. */
async function buildPlan(deps: ExecuteDeps, claimed: ClaimedRun): Promise<ExecutionPlan> {
  const snapshot = runSnapshotSchema.parse(claimed.snapshot);
  // Shared values from the environment, personal ones only the requester's (variables contract section 3).
  const resolved = await resolveRunVariables(
    deps.db,
    { workspaceId: claimed.workspaceId, environmentId: claimed.environmentId, subject: subjectOfRun(claimed), steps: snapshot.scenario.steps },
    (c) => decryptSecret(c, deps.config.encryptionKey),
  );
  if (!resolved.ok) throw new VariableMissingError(resolved.missing);
  const variables: ExecutionPlan["variables"] = resolved.variables;
  const storageState = await requesterSession(deps, claimed);
  return {
    ...(storageState ? { storageState } : {}),
    runId: claimed.id,
    baseUrl: snapshot.environment.baseUrl,
    steps: snapshot.scenario.steps,
    variables,
    device: snapshot.device,
    stepTimeoutMs: RUN_LIMITS.stepTimeoutMs,
    network: { blockPrivateNetworks: deps.config.blockPrivateNetworks },
    // Video only when the request turned it on explicitly (contract section 6).
    capture: { video: runOptionsSchema.parse(claimed.options ?? {}).video === true, traceOnFailure: true },
  };
}

/** Keys only, never values. */
export class VariableMissingError extends Error {
  constructor(keys: string[]) {
    super(`${VARIABLE_MISSING_MESSAGE} Missing: ${keys.join(", ")}`);
  }
}

export class AuthSessionMissingError extends Error {
  constructor() {
    super("The environment needs the requester's own login session, and it is missing or expired.");
  }
}

/**
 * The run's subject's own unexpired login session when the environment needs one — the requester's, or the
 * schedule's / bot token's (stage 4 section 5, stage 5 section 1.1). Never anyone else's: without it the run
 * ends `error(auth_session_missing)`. Memory only.
 */
async function requesterSession(deps: ExecuteDeps, claimed: ClaimedRun): Promise<ExecutionPlan["storageState"]> {
  if (!claimed.environmentId) return undefined;
  const environment = await deps.db.environment.findUnique({ where: { id: claimed.environmentId }, select: { useAuthSession: true } });
  if (!environment?.useAuthSession) return undefined;
  const session = await subjectAuthSession(deps.db, claimed.environmentId, subjectOfRun(claimed));
  if (!session) throw new AuthSessionMissingError();
  return storageStateSchema.parse(JSON.parse(decryptSecret(session.encryptedState, deps.config.encryptionKey)));
}
