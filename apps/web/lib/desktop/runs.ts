// Run APIs of the desktop app (stage 4 contract sections 4.2 and 4.3). Every call first checks ownership
// (token user = device owner = requester = the run's device, else 404), then the stage 3 lease rules.
import { Readable } from "node:stream";
import {
  artifactFits,
  checkReportedVisualVerdict,
  completeDesktopRun,
  pinnedBaselines,
  settleCreatedBaseline,
  desktopHeartbeat,
  failDesktopRun,
  recordDesktopAttempt,
  recordDesktopSteps,
  registerDesktopArtifact,
  startDesktopRun,
  type DesktopStepInput,
} from "@defe2end/db";
import {
  ARTIFACT_CONTENT_TYPES,
  DOM_SUMMARY_MAX_BYTES,
  STEP_LOG_MAX_BYTES,
  can,
  type Role,
  DESKTOP_HEADERS,
  DESKTOP_TIMINGS,
  judgeRun,
  RUN_LIMITS,
  type ArtifactKind,
  type DesktopCompleteRequest,
  type StepOutcome,
} from "@defe2end/shared";
import { artifactKey, BASELINE_MAX_BYTES, storageBaselineFiles } from "@defe2end/shared/server";
import { getDb } from "../db";
import { getStorage } from "../storage";
import { DesktopHttpError, desktopError, type DesktopPrincipal } from "./auth";

/** Artifact uploads carry the lease's claim token here (the body is the file). */
export const CLAIM_TOKEN_HEADER = DESKTOP_HEADERS.claimToken;
export const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
const EXTENSIONS: Record<ArtifactKind, string> = { screenshot: "png", video: "webm", trace: "zip", log: "txt", dom_summary: "txt", visual_diff: "png", a11y_snapshot: "txt" };

export const VERDICT_MISMATCH_MESSAGE = "The app's verdict did not match the step results; the run was stored as an error.";

/**
 * The run, if it is a desktop run of this principal's device requested by this principal's user, and that
 * user is still active and allowed `run.create` (writes) or `run.read` (reads) in the run's workspace. Else
 * 404 — and a run still queued or running whose requester lost the right ends `error(permission_lost)`.
 */
export async function ownedDesktopRun(principal: DesktopPrincipal, runId: string, access: "write" | "read" = "write") {
  const db = getDb();
  const run = await db.run.findFirst({
    where: { id: runId, location: "desktop", desktopDeviceId: principal.deviceId, requestedById: principal.userId },
    select: { id: true, workspaceId: true, status: true, snapshot: true },
  });
  if (!run) throw new DesktopHttpError(desktopError(404, "not_found"));
  const user = await db.user.findUnique({
    where: { id: principal.userId },
    select: { disabledAt: true, isInstanceAdmin: true, memberships: { where: { workspaceId: run.workspaceId }, select: { role: true } } },
  });
  const role = user?.memberships[0]?.role;
  const roles: Record<string, Role> = role ? { [run.workspaceId]: role } : {};
  const allowed = user && !user.disabledAt && can({ userId: principal.userId, isInstanceAdmin: user.isInstanceAdmin, roles }, access === "write" ? "run.create" : "run.read", { type: "run", workspaceId: run.workspaceId }) === "allow";
  if (!allowed) {
    // Losing `run.create` also ends what is still in flight (losing only run.read implies losing run.create).
    await failDesktopRun(db, run.id, ["queued", "running"], "permission_lost", PERMISSION_LOST_RUN_MESSAGE);
    throw new DesktopHttpError(desktopError(404, "not_found"));
  }
  return run;
}

export const PERMISSION_LOST_RUN_MESSAGE = "The requester can no longer run scenarios in this workspace, so the run was stopped.";

const leaseLost = () => new DesktopHttpError(desktopError(409, "lease_lost"));

export async function startRun(principal: DesktopPrincipal, runId: string) {
  await ownedDesktopRun(principal, runId);
  const result = await startDesktopRun(getDb(), runId, principal.deviceId, DESKTOP_TIMINGS.runLeaseMs);
  if (!result.found) throw new DesktopHttpError(desktopError(404, "not_found"));
  return { status: result.status, ...(result.claimToken ? { claimToken: result.claimToken, leaseExpiresAt: result.leaseExpiresAt!.toISOString(), leaseRemainingMs: result.leaseRemainingMs! } : {}) };
}

export async function heartbeatRun(principal: DesktopPrincipal, runId: string, claimToken: string) {
  await ownedDesktopRun(principal, runId);
  const result = await desktopHeartbeat(getDb(), runId, claimToken, DESKTOP_TIMINGS.runLeaseMs);
  if (!result.owned) throw leaseLost();
  return { leaseExpiresAt: result.leaseExpiresAt.toISOString(), leaseRemainingMs: result.leaseRemainingMs, cancelRequested: result.cancelRequested };
}

function toStepInput(step: StepOutcome): DesktopStepInput {
  const { name: _name, retried: _retried, ...rest } = step;
  return rest as DesktopStepInput;
}

export async function recordSteps(
  principal: DesktopPrincipal,
  runId: string,
  body: { claimToken: string; events: ({ type: "stepStarted"; attempt: number } | { type: "stepFinished"; result: StepOutcome })[] },
) {
  await ownedDesktopRun(principal, runId);
  const db = getDb();
  const finished = body.events.flatMap((e) => (e.type === "stepFinished" ? [toStepInput(e.result)] : []));
  const attempt = Math.max(0, ...body.events.map((e) => (e.type === "stepStarted" ? e.attempt : e.result.attempt)));
  if (attempt > 0 && !(await recordDesktopAttempt(db, runId, body.claimToken, attempt))) throw leaseLost();
  if (finished.length > 0 && !(await recordDesktopSteps(db, runId, body.claimToken, finished))) throw leaseLost();
  await settleVisualSteps(runId, finished);
}

/**
 * Stage 7 section 4: an app's visual verdict is kept only when its baseline version is pinned for this run and
 * key (else `skipped`); a `created` one makes the first baseline, or is compared on the server if another run
 * made it first. Runs while the pins still exist, before the run is completed.
 */
async function settleVisualSteps(runId: string, steps: DesktopStepInput[]): Promise<void> {
  const db = getDb();
  for (const step of steps) {
    if (!step.visualVerdict) continue;
    const row = await db.stepResult.findUnique({ where: { runId_attempt_index: { runId, attempt: step.attempt, index: step.index } }, select: { id: true, visualVerdict: true, visualServerVerdict: true, visualBaselineVersionId: true } });
    if (!row || row.visualServerVerdict) continue;
    if (row.visualVerdict === "created") {
      if (!row.visualBaselineVersionId) await settleCreatedBaseline(db, storageBaselineFiles(getStorage()), row.id);
    } else await checkReportedVisualVerdict(db, row.id);
  }
}

/**
 * Re-judges with the shared function; a different verdict than the app's is stored as `error(verdict_mismatch)`.
 * A run that already ended answers 409 run_finalized (final for the app).
 */
export async function completeRun(principal: DesktopPrincipal, runId: string, body: DesktopCompleteRequest) {
  await ownedDesktopRun(principal, runId);
  const judged = judgeRun(body.steps, body.stopCause);
  // Steps reported only here (the live reports are best effort) get their visual verdict checked first.
  const visualSteps = body.steps.filter((s) => s.visualVerdict).map(toStepInput);
  if (visualSteps.length > 0) {
    if (!(await recordDesktopSteps(getDb(), runId, body.claimToken, visualSteps))) throw leaseLost();
    await settleVisualSteps(runId, visualSteps);
  }
  const mismatch = judged.status !== body.verdict;
  const result = await completeDesktopRun(getDb(), runId, body.claimToken, body.steps.map(toStepInput), {
    status: mismatch ? "error" : judged.status,
    errorCode: mismatch ? "verdict_mismatch" : judged.errorCode,
    errorMessage: mismatch ? VERDICT_MISMATCH_MESSAGE : undefined,
    warningCount: judged.warningCount,
    attemptCount: Math.max(body.attemptCount, judged.attemptCount),
    passedAfterRetry: mismatch ? false : judged.passedAfterRetry,
  });
  if (result.result === "finalized") throw new DesktopHttpError(desktopError(409, "run_finalized", { status: result.status }));
  if (result.result === "lease_lost") throw leaseLost();
  return { status: mismatch ? "error" : judged.status };
}

/** `step-{n}` for screenshots, DOM summaries, visual diffs, accessibility snapshots and a step's log, `main`/`popup-N` for video, `trace`, `log` for the run-wide log. */
export function parseArtifactKey(kind: string, key: string): { kind: ArtifactKind; stepIndex?: number } | null {
  if (kind === "screenshot" || kind === "dom_summary" || kind === "visual_diff" || kind === "a11y_snapshot") {
    const m = /^step-(\d{1,4})$/.exec(key);
    return m ? { kind, stepIndex: Number(m[1]) } : null;
  }
  if (kind === "video") return /^(main|popup-\d{1,3})$/.test(key) ? { kind } : null;
  if (kind === "trace") return key === "trace" ? { kind } : null;
  if (kind === "log") {
    if (key === "log") return { kind };
    const m = /^step-(\d{1,4})$/.exec(key);
    return m ? { kind, stepIndex: Number(m[1]) } : null;
  }
  return null;
}

/**
 * Streams one artifact to storage. Content-Length is required; the run total (200MB, same key counted once)
 * is checked before and — authoritatively, under the row lock — after storing. Over it: 413.
 */
export async function putArtifact(principal: DesktopPrincipal, runId: string, params: { kind: string; attempt: string; key: string }, request: Request, claimToken: string | null) {
  const run = await ownedDesktopRun(principal, runId);
  const parsed = parseArtifactKey(params.kind, params.key);
  const attempt = Number(params.attempt);
  if (!parsed || !Number.isInteger(attempt) || attempt < 1) throw new DesktopHttpError(desktopError(400, "invalid_request", { message: "Unknown artifact kind, attempt or key" }));
  if (!claimToken) throw leaseLost();
  const length = Number(request.headers.get("content-length"));
  if (!request.headers.get("content-length") || !Number.isInteger(length) || length < 0) throw new DesktopHttpError(desktopError(411, "invalid_request", { message: "Content-Length is required" }));
  const limit = RUN_LIMITS.runArtifactBytes;
  if ((parsed.kind === "screenshot" || parsed.kind === "visual_diff") && length > SCREENSHOT_MAX_BYTES) throw new DesktopHttpError(desktopError(413, "payload_too_large"));
  if (parsed.kind === "dom_summary" && length > DOM_SUMMARY_MAX_BYTES) throw new DesktopHttpError(desktopError(413, "payload_too_large"));
  if (parsed.kind === "log" && parsed.stepIndex !== undefined && length > STEP_LOG_MAX_BYTES) throw new DesktopHttpError(desktopError(413, "payload_too_large"));
  const key = { kind: parsed.kind, attempt, name: params.key, stepIndex: parsed.stepIndex };
  const owned = { id: run.id, workspaceId: run.workspaceId, claimToken };
  const fits = await artifactFits(getDb(), owned, key, length, limit);
  if (fits === "lease_lost") throw leaseLost();
  if (fits === "too_large") throw new DesktopHttpError(desktopError(413, "payload_too_large"));
  if (!request.body) throw new DesktopHttpError(desktopError(400, "invalid_request", { message: "Body required" }));

  const storage = getStorage();
  const storageKey = artifactKey(run.workspaceId, run.id, EXTENSIONS[parsed.kind]);
  const { sizeBytes } = await storage.put(storageKey, capped(Readable.fromWeb(request.body as never), length));
  const registered = await registerDesktopArtifact(getDb(), owned, key, { storageKey, contentType: ARTIFACT_CONTENT_TYPES[parsed.kind], sizeBytes }, limit).catch(async (err) => {
    await storage.delete(storageKey);
    throw err;
  });
  if (!registered.ok) {
    await storage.delete(storageKey);
    throw registered.reason === "lease_lost" ? leaseLost() : new DesktopHttpError(desktopError(413, "payload_too_large"));
  }
  for (const old of registered.replaced) await storage.delete(old).catch(() => {});
  return { sizeBytes };
}

/** Stops at the declared length: a body longer than its Content-Length fails instead of growing the total. */
async function* capped(source: AsyncIterable<Uint8Array>, max: number): AsyncIterable<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > max) throw new DesktopHttpError(desktopError(400, "invalid_request", { message: "Body longer than Content-Length" }));
    yield chunk;
  }
}

/** A file pinned in the run's snapshot (never a newer version). */
export async function getAttachment(principal: DesktopPrincipal, runId: string, attachmentId: string): Promise<Response> {
  const run = await ownedDesktopRun(principal, runId, "read");
  const pinned = ((run.snapshot as { attachments?: { id: string }[] }).attachments ?? []).some((a) => a.id === attachmentId);
  if (!pinned) throw new DesktopHttpError(desktopError(404, "not_found"));
  const row = await getDb().attachment.findFirst({ where: { id: attachmentId, workspaceId: run.workspaceId } });
  if (!row) throw new DesktopHttpError(desktopError(404, "not_found"));
  const stream = await getStorage().get(row.storageKey);
  return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { "content-type": row.contentType, "content-length": String(row.sizeBytes) } });
}

/**
 * A baseline image pinned for this run (stage 7 section 4): the run must be this device's and user's and still
 * running, and the version in its pin list. Streamed from storage, never a redirect; capped at 20MB.
 */
export async function getBaseline(principal: DesktopPrincipal, runId: string, versionId: string): Promise<Response> {
  const run = await ownedDesktopRun(principal, runId, "read");
  if (run.status !== "running") throw new DesktopHttpError(desktopError(404, "not_found"));
  const pin = (await pinnedBaselines(getDb(), run.id)).find((p) => p.versionId === versionId);
  if (!pin) throw new DesktopHttpError(desktopError(404, "not_found"));
  const stat = await getStorage().stat(pin.storageKey);
  if (!stat) throw new DesktopHttpError(desktopError(404, "not_found"));
  if (stat.sizeBytes > BASELINE_MAX_BYTES) throw new DesktopHttpError(desktopError(413, "payload_too_large"));
  const stream = await getStorage().get(pin.storageKey);
  return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { "content-type": "image/png", "content-length": String(stat.sizeBytes), "cache-control": "no-store" } });
}
