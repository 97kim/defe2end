// The `run` message (stage 4 contract section 4.1): plan with variable values read now, run policy, pinned
// attachments and, for environments that need it, the requester's login session. Memory only, never logged.
import { markDesktopVariablesResolved, resolveRunVariables, subjectAuthSession, subjectOfRun, VARIABLE_MISSING_MESSAGE, type DispatchedRun } from "@defe2end/db";
import {
  DESKTOP_MAX_CONCURRENCY,
  parseRunAttempts,
  RUN_LIMITS,
  runOptionsSchema,
  runSnapshotSchema,
  storageStateSchema,
  type DesktopRunMessage,
  type ExecutionPlan,
} from "@defe2end/shared";
import { getDb } from "../db";
import { decrypt } from "../encryption";

export function desktopRunTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.RUN_TIMEOUT_MS);
  return Number.isInteger(n) && n >= 1_000 ? n : RUN_LIMITS.runTimeoutMs;
}

export async function buildRunMessage(run: DispatchedRun): Promise<DesktopRunMessage> {
  const db = getDb();
  const snapshot = runSnapshotSchema.parse(run.snapshot);
  const options = runOptionsSchema.parse(run.options ?? {});
  // Same resolution as the worker: shared from the environment, personal only the requester's.
  const resolved = await resolveRunVariables(db, { workspaceId: run.workspaceId, environmentId: run.environmentId, subject: subjectOfRun(run), steps: snapshot.scenario.steps }, decrypt);
  if (!resolved.ok) throw new VariableMissingError(resolved.missing);
  const variables: ExecutionPlan["variables"] = resolved.variables;
  await markDesktopVariablesResolved(db, run.id);

  const storageState = await requesterSession(run);
  if (storageState === null) throw new AuthSessionMissingError();
  const attachmentRows = snapshot.attachments.length
    ? await db.attachment.findMany({ where: { workspaceId: run.workspaceId, id: { in: snapshot.attachments.map((a) => a.id) } } })
    : [];
  const group = run.groupRunId ? await db.groupRun.findUnique({ where: { id: run.groupRunId }, select: { mode: true } }) : null;

  return {
    type: "run",
    runId: run.id,
    workspaceId: run.workspaceId,
    groupRunId: run.groupRunId,
    groupIndex: run.groupIndex,
    trigger: run.trigger,
    plan: {
      runId: run.id,
      baseUrl: snapshot.environment.baseUrl,
      steps: snapshot.scenario.steps,
      variables,
      device: snapshot.device,
      stepTimeoutMs: RUN_LIMITS.stepTimeoutMs,
      // The user's own PC reaches its own network; the private-range block is for the shared server.
      network: { blockPrivateNetworks: false },
      capture: { video: options.video === true, traceOnFailure: true },
      ...(storageState ? { storageState } : {}),
    },
    policy: {
      retryAttempts: snapshot.scenario.retryOnFailure ? parseRunAttempts(process.env.RUN_RETRY_ATTEMPTS) : 1,
      runTimeoutMs: desktopRunTimeoutMs(),
      video: options.video === true,
      traceOnFailure: true,
    },
    attachments: attachmentRows.map((a) => ({ id: a.id, name: a.name, version: a.version, contentType: a.contentType, sizeBytes: a.sizeBytes })),
    concurrency: group?.mode === "parallel" ? DESKTOP_MAX_CONCURRENCY : 1,
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
    super("The environment needs your login session, and it is missing or expired. Save it again.");
  }
}

/** The requester's own unexpired session of the run's environment, when the environment needs one. */
async function requesterSession(run: DispatchedRun) {
  if (!run.environmentId) return undefined;
  const db = getDb();
  const environment = await db.environment.findUnique({ where: { id: run.environmentId }, select: { useAuthSession: true } });
  if (!environment?.useAuthSession) return undefined;
  // The run's subject's own session; required but gone (deleted or expired since creation) → null, never a fallback.
  const session = await subjectAuthSession(db, run.environmentId, subjectOfRun(run));
  if (!session) return null;
  return storageStateSchema.parse(JSON.parse(decrypt(session.encryptedState)));
}
