// Environment comparison (stage 7 contract section 6): one scenario run in two environments of a site, then
// the screens and accessibility structures compared step by step. The comparison and its two child runs are
// created together; the result is written once, by whoever holds a live claim on the comparison row.
import { createHash, randomUUID } from "node:crypto";
import { diffStructure, MASKING_POLICY_VERSION, renderConditionDiff, renderConditionsSchema, STRUCTURE_LIMITS, type ComparisonVerdict } from "@defe2end/shared";
import { compareImages, environmentScreenVerdict, VISUAL_DEFAULT_TOLERANCE, VISUAL_SHIFT_RANGE, type StorageDriver } from "@defe2end/shared/server";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createRunsInTx, findEnvironment, findScenarios, RunCreateError, scenarioRun, type RunCreateEnv } from "./run-create.js";
import { subjectAuthSession } from "./variables.js";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

export const COMPARISON_CLAIM_MS = 2 * 60_000;
export const COMPARISON_EXTEND_MS = 60_000;
export const COMPARISON_CONDITIONS_VERSION = 1;
const TERMINAL = ["passed", "failed", "error", "cancelled", "timed_out"];

/** Reasons a comparison can't start (400 with the list). Codes; the web app shows the text. */
export type ComparisonStartReason =
  | "same_environment"
  | "different_site"
  | "same_base_url"
  | "no_screenshot_step"
  | "auth_session_missing_left"
  | "auth_session_missing_right"
  | "desktop_not_connected"
  | "app_update_required";

export class ComparisonStartError extends Error {
  constructor(readonly reasons: ComparisonStartReason[], readonly missing: string[] = []) {
    super(`The comparison can't start: ${reasons.join(", ")}`);
  }
}

export interface CreateComparisonInput {
  workspaceId: string;
  userId: string;
  scenarioId: string;
  leftEnvironmentId: string;
  rightEnvironmentId: string;
  location: "server" | "desktop";
  deviceId?: string;
  /** Percent, 0..100; default 5. */
  tolerance?: number;
}

/**
 * Checks, then creates the comparison and its two children in one transaction. The children's snapshots
 * turn whole-run retry off (one attempt, so the screens never mix); step retries stay.
 */
export async function createEnvComparison(db: Db, input: CreateComparisonInput, env: RunCreateEnv): Promise<{ comparisonId: string; runIds: [string, string] }> {
  const tolerance = input.tolerance ?? VISUAL_DEFAULT_TOLERANCE;
  if (!(tolerance >= 0 && tolerance <= 100)) throw new RunCreateError("invalid_request", "The tolerance must be between 0 and 100");
  return db.$transaction(async (tx) => {
    const left = await findEnvironment(tx, input.workspaceId, input.leftEnvironmentId);
    const right = await findEnvironment(tx, input.workspaceId, input.rightEnvironmentId);
    const scenarioRow = await tx.scenario.findFirst({ where: { id: input.scenarioId, workspaceId: input.workspaceId }, select: { siteId: true, maskingEnabled: true } });
    if (!scenarioRow) throw RunCreateError.notFound();
    const [scenario] = await findScenarios(tx, input.workspaceId, [input.scenarioId], scenarioRow.siteId);
    const reasons: ComparisonStartReason[] = [];
    if (left.id === right.id) reasons.push("same_environment");
    if (left.siteId !== scenarioRow.siteId || right.siteId !== scenarioRow.siteId) reasons.push("different_site");
    if (left.id !== right.id && sameBase(left.baseUrl, right.baseUrl)) reasons.push("same_base_url");
    const leftSpec = await scenarioRun(tx, input.workspaceId, scenario!, left);
    const steps = leftSpec.snapshot.scenario.steps;
    if (!steps.some((s) => s.action === "screenshot")) reasons.push("no_screenshot_step");
    const subject = { kind: "user", userId: input.userId } as const;
    const sessions = await tx.environment.findMany({ where: { id: { in: [left.id, right.id] } }, select: { id: true, useAuthSession: true } });
    const useAuthSession = sessions.some((s) => s.useAuthSession);
    for (const [side, envRow] of [["left", left], ["right", right]] as const) {
      if (sessions.find((s) => s.id === envRow.id)?.useAuthSession && !(await subjectAuthSession(tx, envRow.id, subject))) reasons.push(`auth_session_missing_${side}`);
    }
    if (reasons.length > 0) throw new ComparisonStartError(reasons);

    const conditions = {
      formatVersion: COMPARISON_CONDITIONS_VERSION,
      steps,
      device: leftSpec.snapshot.device,
      masking: leftSpec.snapshot.masking ?? { enabled: scenarioRow.maskingEnabled, selectors: [], policyVersion: MASKING_POLICY_VERSION },
      useAuthSession,
      tolerance,
      shiftRange: VISUAL_SHIFT_RANGE,
      limits: STRUCTURE_LIMITS,
    };
    const comparison = await tx.envComparison.create({
      data: {
        workspaceId: input.workspaceId,
        scenarioId: input.scenarioId,
        siteId: scenarioRow.siteId,
        leftEnvironmentId: left.id,
        rightEnvironmentId: right.id,
        leftBaseUrl: left.baseUrl,
        rightBaseUrl: right.baseUrl,
        location: input.location,
        conditions: conditions as Prisma.InputJsonValue,
        tolerance,
        createdById: input.userId,
      },
      select: { id: true },
    });
    const runIds: string[] = [];
    let deviceId = input.deviceId;
    for (const [side, envRow] of [["left", left], ["right", right]] as const) {
      const spec = side === "left" ? leftSpec : await scenarioRun(tx, input.workspaceId, scenario!, envRow);
      spec.snapshot.scenario.retryOnFailure = false;
      const created = await createRunsInTx(
        tx,
        {
          workspaceId: input.workspaceId,
          subject,
          trigger: "manual",
          requestHash: `comparison:${comparison.id}:${side}`,
          options: {},
          placement: { location: input.location, deviceId },
          comparisonChild: true,
          resolve: async () => ({ environmentId: envRow.id, runs: [spec] }),
        },
        env,
      );
      const runId = created.runIds[0]!;
      const run = await tx.run.update({ where: { id: runId }, data: { comparisonId: comparison.id, comparisonSide: side }, select: { desktopDeviceId: true } });
      // Both sides on the same device.
      if (run.desktopDeviceId) deviceId = run.desktopDeviceId;
      runIds.push(runId);
    }
    if (deviceId && input.location === "desktop") await tx.envComparison.update({ where: { id: comparison.id }, data: { deviceId } });
    return { comparisonId: comparison.id, runIds: runIds as [string, string] };
  }, { timeout: 20_000 });
}

function sameBase(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const url = new URL(u);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      return u.trim().toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

// --- Claim -----------------------------------------------------------------------------

export interface ComparisonClaim {
  id: string;
  round: number;
  token: string;
}

/**
 * `running → comparing` when both children are terminal, or re-claims a `comparing` row whose claim expired.
 * Conditional: of concurrent callers one wins, the others get null.
 */
export async function claimComparison(db: Db | Tx, comparisonId: string): Promise<ComparisonClaim | null> {
  const token = randomUUID();
  const rows = await db.$queryRaw<{ round: number }[]>`
    UPDATE "EnvComparison" c SET status = 'comparing', "claimToken" = ${token},
      "claimExpiresAt" = clock_timestamp() + ${COMPARISON_CLAIM_MS}::bigint * interval '1 millisecond', "updatedAt" = clock_timestamp()
    WHERE c.id = ${comparisonId}
      AND (
        (c.status = 'running' AND NOT EXISTS (SELECT 1 FROM "Run" r WHERE r."comparisonId" = c.id AND r.status::text <> ALL(${TERMINAL})))
        OR (c.status = 'comparing' AND c."claimExpiresAt" <= clock_timestamp())
      )
    RETURNING round`;
  return rows[0] ? { id: comparisonId, round: rows[0].round, token } : null;
}

/** Pushes the claim one minute on. False: the claim was lost, stop at once. */
export async function extendComparisonClaim(db: Db, claim: ComparisonClaim): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE "EnvComparison" SET "claimExpiresAt" = clock_timestamp() + ${COMPARISON_EXTEND_MS}::bigint * interval '1 millisecond'
    WHERE id = ${claim.id} AND status = 'comparing' AND round = ${claim.round} AND "claimToken" = ${claim.token} AND "claimExpiresAt" > clock_timestamp()`;
  return n === 1;
}

/** Comparisons ready to finish: both children ended while `running`, or an expired `comparing` claim. */
export async function findComparisonsToFinish(db: Db, limit = 20): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c.id FROM "EnvComparison" c
    WHERE (c.status = 'running' AND NOT EXISTS (SELECT 1 FROM "Run" r WHERE r."comparisonId" = c.id AND r.status::text <> ALL(${TERMINAL})))
       OR (c.status = 'comparing' AND c."claimExpiresAt" <= clock_timestamp())
    ORDER BY c."createdAt" LIMIT ${limit}::int`;
  return rows.map((r) => r.id);
}

// --- Verdicts ----------------------------------------------------------------------------

export interface StepComparison {
  stepId: string;
  leftStepResultId: string | null;
  rightStepResultId: string | null;
  screenVerdict: ComparisonVerdict;
  screenDiffPercent?: number;
  screenShiftDiffPercent?: number;
  screenShift?: { x: number; y: number };
  screenTolerance: number;
  screenDiffKey?: string;
  structureVerdict: ComparisonVerdict;
  structureMoved?: number;
  structureAdded?: number;
  structureRemoved?: number;
  structureChanged?: number;
  structureDiffKey?: string;
  /** Codes, `;`-joined: `child_failed`, `missing_capture`, `render_mismatch:<fields>`, `masking_failed`, `compare_failed`, structure limit codes. */
  reason?: string;
  /** Makes the whole comparison `incomparable` (render mismatch, masking failure). */
  taints?: boolean;
}

/**
 * Overall verdict of one kind (screen or structure): a failed or cancelled child, a masking failure or a
 * render mismatch anywhere → `incomparable`, even next to differences. Else any `different` → `different`,
 * any `incomparable` → `incomparable`, else `same`.
 */
export function overallVerdict(steps: { verdict: ComparisonVerdict; taints?: boolean }[], childrenPassed: boolean): ComparisonVerdict {
  if (!childrenPassed || steps.some((s) => s.taints)) return "incomparable";
  if (steps.some((s) => s.verdict === "different")) return "different";
  if (steps.length === 0 || steps.some((s) => s.verdict === "incomparable")) return "incomparable";
  return "same";
}

// --- The job -----------------------------------------------------------------------------

async function readAll(storage: StorageDriver, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await storage.get(key)) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function* once(body: Uint8Array): AsyncIterable<Uint8Array> {
  yield body;
}

function fileKey(workspaceId: string, claim: ComparisonClaim, stepId: string, kind: "screen" | "structure"): string {
  const step = createHash("sha256").update(stepId).digest("hex").slice(0, 16);
  return `workspaces/${workspaceId}/comparisons/${claim.id}/r${claim.round}-${claim.token}/${step}-${kind}.${kind === "screen" ? "png" : "json"}`.toLowerCase();
}

/** Thrown inside the job when the claim is lost; the job stops without writing. */
class ClaimLost extends Error {}

/** Lets tests stop the job between steps (process death). */
export interface ComparisonJobHooks {
  afterStep?: (index: number) => Promise<void> | void;
}

/**
 * Compares the claimed round and stores the result. Returns false when the claim was lost on the way
 * (nothing written to the result; files already written stay unreferenced for the orphan sweep).
 */
export async function runComparisonJob(db: Db, storage: StorageDriver, claim: ComparisonClaim, hooks: ComparisonJobHooks = {}): Promise<boolean> {
  const comparison = await db.envComparison.findUniqueOrThrow({
    where: { id: claim.id },
    select: { workspaceId: true, conditions: true, tolerance: true, leftBaseUrl: true, rightBaseUrl: true, runs: { select: { id: true, status: true, comparisonSide: true } } },
  });
  const leftRun = comparison.runs.find((r) => r.comparisonSide === "left");
  const rightRun = comparison.runs.find((r) => r.comparisonSide === "right");
  const childrenPassed = leftRun?.status === "passed" && rightRun?.status === "passed";
  const conditionSteps = ((comparison.conditions as { steps?: { id: string; action: string }[] }).steps ?? []).filter((s) => s.action === "screenshot");
  const [leftSide, rightSide] = await Promise.all([loadSide(db, leftRun?.id), loadSide(db, rightRun?.id)]);
  const results: StepComparison[] = [];
  try {
    for (const [index, step] of conditionSteps.entries()) {
      results.push(await compareStep(db, storage, claim, comparison, step.id, leftSide.get(step.id), rightSide.get(step.id)));
      await hooks.afterStep?.(index);
      if (!(await extendComparisonClaim(db, claim))) throw new ClaimLost();
    }
  } catch (err) {
    if (err instanceof ClaimLost) return false;
    return commitComparison(db, claim, { error: (err as Error).message.slice(0, 500) });
  }
  return commitComparison(db, claim, {
    steps: results,
    screenVerdict: overallVerdict(results.map((r) => ({ verdict: r.screenVerdict, taints: r.taints })), childrenPassed),
    structureVerdict: overallVerdict(results.map((r) => ({ verdict: r.structureVerdict, taints: r.taints })), childrenPassed),
  });
}

interface SideCapture {
  stepResultId: string;
  status: string;
  render: unknown;
  screenshotKey?: string;
  snapshotKey?: string;
}

async function loadSide(db: Db, runId: string | undefined): Promise<Map<string, SideCapture>> {
  const out = new Map<string, SideCapture>();
  if (!runId) return out;
  const [results, artifacts] = await Promise.all([
    db.stepResult.findMany({ where: { runId, action: "screenshot" }, orderBy: [{ attempt: "asc" }], select: { id: true, stepId: true, index: true, attempt: true, status: true, render: true } }),
    db.artifact.findMany({ where: { runId, kind: { in: ["screenshot", "a11y_snapshot"] } }, orderBy: { createdAt: "asc" }, select: { kind: true, stepIndex: true, attempt: true, storageKey: true } }),
  ]);
  for (const r of results) {
    const mine = artifacts.filter((a) => a.stepIndex === r.index && a.attempt === r.attempt);
    out.set(r.stepId, {
      stepResultId: r.id,
      status: r.status,
      render: r.render,
      screenshotKey: mine.filter((a) => a.kind === "screenshot").at(-1)?.storageKey,
      snapshotKey: mine.filter((a) => a.kind === "a11y_snapshot").at(-1)?.storageKey,
    });
  }
  return out;
}

async function compareStep(
  db: Db,
  storage: StorageDriver,
  claim: ComparisonClaim,
  comparison: { workspaceId: string; tolerance: number; leftBaseUrl: string; rightBaseUrl: string },
  stepId: string,
  left: SideCapture | undefined,
  right: SideCapture | undefined,
): Promise<StepComparison> {
  const out: StepComparison = {
    stepId,
    leftStepResultId: left?.stepResultId ?? null,
    rightStepResultId: right?.stepResultId ?? null,
    screenVerdict: "incomparable",
    structureVerdict: "incomparable",
    screenTolerance: comparison.tolerance,
  };
  const reasons: string[] = [];
  if (!left || !right || left.status !== "passed" || right.status !== "passed") {
    out.reason = left && right ? "child_failed" : "missing_capture";
    return out;
  }
  const lr = renderConditionsSchema.safeParse(left.render);
  const rr = renderConditionsSchema.safeParse(right.render);
  if (!lr.success || !rr.success) {
    reasons.push("render_missing");
    out.taints = true;
  } else {
    const fields = renderConditionDiff(lr.data, rr.data);
    if (fields.length > 0) {
      reasons.push(`render_mismatch:${fields.join(",")}`);
      out.taints = true;
    }
  }

  if (left.screenshotKey && right.screenshotKey) {
    try {
      const result = await compareImages(await readAll(storage, left.screenshotKey), await readAll(storage, right.screenshotKey), { tolerance: comparison.tolerance, mode: "environment" });
      if (result.diffPng) {
        out.screenDiffKey = await writeFile(db, storage, comparison.workspaceId, claim, stepId, "screen", result.diffPng);
      }
      out.screenDiffPercent = result.diffPercent;
      out.screenShiftDiffPercent = result.shiftDiffPercent;
      out.screenShift = result.shift;
      if (!out.taints) out.screenVerdict = environmentScreenVerdict(result, comparison.tolerance);
    } catch (err) {
      if (err instanceof ClaimLost) throw err;
      reasons.push("compare_failed");
    }
  } else reasons.push("missing_capture");

  if (!left.snapshotKey || !right.snapshotKey) {
    // A passed screenshot step without a snapshot: hiding didn't apply, so nothing was stored.
    reasons.push("masking_failed");
    out.taints = true;
  } else {
    const result = diffStructure((await readAll(storage, left.snapshotKey)).toString("utf8"), (await readAll(storage, right.snapshotKey)).toString("utf8"), {
      leftOrigin: comparison.leftBaseUrl,
      rightOrigin: comparison.rightBaseUrl,
    });
    if (result.reason) reasons.push(result.reason);
    if (result.counts) {
      out.structureMoved = result.counts.moved;
      out.structureAdded = result.counts.rightOnly;
      out.structureRemoved = result.counts.leftOnly;
      out.structureChanged = result.counts.changed;
    }
    if (result.entries && result.verdict === "different") {
      out.structureDiffKey = await writeFile(db, storage, comparison.workspaceId, claim, stepId, "structure", new TextEncoder().encode(JSON.stringify({ counts: result.counts, entries: result.entries })));
    }
    if (!out.taints) out.structureVerdict = result.verdict;
  }
  if (reasons.length > 0) out.reason = reasons.join(";");
  return out;
}

/** File first, then its row under the live claim; a refused row leaves the file for the orphan sweep. */
async function writeFile(db: Db, storage: StorageDriver, workspaceId: string, claim: ComparisonClaim, stepId: string, kind: "screen" | "structure", body: Uint8Array): Promise<string> {
  const key = fileKey(workspaceId, claim, stepId, kind);
  await storage.put(key, once(body));
  const n = await db.$executeRaw`
    INSERT INTO "EnvComparisonFile" (id, "comparisonId", round, "claimToken", kind, "storageKey")
    SELECT ${randomUUID()}, id, round, "claimToken", ${kind === "screen" ? "screen_diff" : "structure_diff"}::"EnvComparisonFileKind", ${key}
    FROM "EnvComparison" WHERE id = ${claim.id} AND status = 'comparing' AND round = ${claim.round} AND "claimToken" = ${claim.token} AND "claimExpiresAt" > clock_timestamp()`;
  if (n !== 1) throw new ClaimLost();
  return key;
}

type CommitInput = { error: string } | { steps: StepComparison[]; screenVerdict: ComparisonVerdict; structureVerdict: ComparisonVerdict };

/** Locks the row and writes only while the claim is still this job's and live. */
export async function commitComparison(db: Db, claim: ComparisonClaim, input: CommitInput): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "EnvComparison"
      WHERE id = ${claim.id} AND status = 'comparing' AND round = ${claim.round} AND "claimToken" = ${claim.token} AND "claimExpiresAt" > clock_timestamp()
      FOR UPDATE`;
    if (!row) return false;
    if ("error" in input) {
      await tx.$executeRaw`UPDATE "EnvComparison" SET status = 'error', error = ${input.error}, "claimToken" = NULL, "claimExpiresAt" = NULL, "finishedAt" = clock_timestamp(), "updatedAt" = clock_timestamp() WHERE id = ${claim.id}`;
      return true;
    }
    await tx.envComparisonStep.deleteMany({ where: { comparisonId: claim.id, round: claim.round } });
    for (const s of input.steps) {
      const { taints: _taints, screenShift, ...rest } = s;
      await tx.envComparisonStep.create({ data: { ...rest, comparisonId: claim.id, round: claim.round, ...(screenShift ? { screenShift } : {}) } });
    }
    await tx.$executeRaw`
      UPDATE "EnvComparison" SET status = 'done', "screenVerdict" = ${input.screenVerdict}::"ComparisonVerdict", "structureVerdict" = ${input.structureVerdict}::"ComparisonVerdict",
        error = NULL, "claimToken" = NULL, "claimExpiresAt" = NULL, "finishedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
      WHERE id = ${claim.id}`;
    return true;
  });
}

/** Tries to finish these comparisons (or every ready one): claim, then run the job. Call after a child ends. */
export async function finishComparisons(db: Db, storage: StorageDriver, comparisonIds?: string[]): Promise<number> {
  const ids = comparisonIds ?? (await findComparisonsToFinish(db));
  let done = 0;
  for (const id of ids) {
    const claim = await claimComparison(db, id);
    if (claim && (await runComparisonJob(db, storage, claim))) done++;
  }
  return done;
}

/** The comparisons these runs belong to (for the finish points). */
export async function comparisonsOfRuns(db: Db, runIds: string[]): Promise<string[]> {
  if (runIds.length === 0) return [];
  const rows = await db.run.findMany({ where: { id: { in: runIds }, comparisonId: { not: null } }, select: { comparisonId: true } });
  return [...new Set(rows.map((r) => r.comparisonId!))];
}

// --- Compare again, cancel --------------------------------------------------------------------

export type ComparisonActionResult = { ok: true; claim?: ComparisonClaim } | { ok: false; code: "not_found" | "conflict" | "forbidden" | "invalid_request"; message: string };

/** `done`/`error` with both children ended → new round and claim, optional new tolerance. */
export async function recompareComparison(db: Db, workspaceId: string, comparisonId: string, tolerance?: number): Promise<ComparisonActionResult> {
  if (tolerance !== undefined && !(tolerance >= 0 && tolerance <= 100)) return { ok: false, code: "invalid_request", message: "The tolerance must be between 0 and 100" };
  const exists = await db.envComparison.findFirst({ where: { id: comparisonId, workspaceId }, select: { status: true } });
  if (!exists) return { ok: false, code: "not_found", message: "Not found" };
  const token = randomUUID();
  const rows = await db.$queryRaw<{ round: number }[]>`
    UPDATE "EnvComparison" c SET status = 'comparing', round = c.round + 1, "claimToken" = ${token},
      "claimExpiresAt" = clock_timestamp() + ${COMPARISON_CLAIM_MS}::bigint * interval '1 millisecond',
      tolerance = coalesce(${tolerance ?? null}::float8, c.tolerance), "finishedAt" = NULL, "updatedAt" = clock_timestamp()
    WHERE c.id = ${comparisonId} AND c.status IN ('done', 'error')
      AND NOT EXISTS (SELECT 1 FROM "Run" r WHERE r."comparisonId" = c.id AND r.status::text <> ALL(${TERMINAL}))
    RETURNING round`;
  if (!rows[0]) return { ok: false, code: "conflict", message: "Only a finished comparison can be compared again" };
  return { ok: true, claim: { id: comparisonId, round: rows[0].round, token } };
}

/** `running` only: the comparison `cancelled` and both children's cancel requested, in one transaction. */
export async function cancelComparison(db: Db, workspaceId: string, comparisonId: string, userId: string | null): Promise<ComparisonActionResult> {
  return db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ status: string; location: string; ownerId: string | null }[]>`
      SELECT c.status::text, c.location::text, d."userId" AS "ownerId" FROM "EnvComparison" c LEFT JOIN "DesktopDevice" d ON d.id = c."deviceId"
      WHERE c.id = ${comparisonId} AND c."workspaceId" = ${workspaceId} FOR UPDATE OF c`;
    if (!row) return { ok: false as const, code: "not_found" as const, message: "Not found" };
    if (row.location === "desktop" && row.ownerId !== userId) return { ok: false as const, code: "forbidden" as const, message: "Only the owner of the device can cancel this comparison" };
    if (row.status !== "running") return { ok: false as const, code: "conflict" as const, message: "Only a running comparison can be cancelled" };
    await tx.$executeRaw`UPDATE "EnvComparison" SET status = 'cancelled', "finishedAt" = clock_timestamp(), "updatedAt" = clock_timestamp() WHERE id = ${comparisonId}`;
    await tx.$executeRaw`
      UPDATE "Run" SET status = 'cancelled', "cancelRequestedAt" = coalesce("cancelRequestedAt", clock_timestamp()), "cancelRequestedById" = coalesce("cancelRequestedById", ${userId}), "finishedAt" = clock_timestamp()
      WHERE "comparisonId" = ${comparisonId} AND status = 'queued'`;
    await tx.$executeRaw`
      UPDATE "Run" SET "cancelRequestedAt" = coalesce("cancelRequestedAt", clock_timestamp()), "cancelRequestedById" = coalesce("cancelRequestedById", ${userId})
      WHERE "comparisonId" = ${comparisonId} AND status = 'running'`;
    return { ok: true as const };
  });
}
