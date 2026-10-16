// Visual regression baselines (stage 7 contract section 4): pinning at run creation, the first baseline and
// its race, checking an app's verdict, approval, and dropping the pins when the run ends.
import { renderConditionDiff, renderConditionsSchema, runSnapshotSchema, VISUAL_RUNTIMES, VISUAL_WARNING_VERDICTS, visualDeviceKey, type RenderConditions, type RunSnapshot, type VisualRuntime, type VisualVerdict } from "@defe2end/shared";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

/** What the baseline code needs from storage (the worker's and the web app's `StorageDriver` fit). */
export interface BaselineFiles {
  read(key: string): Promise<Uint8Array>;
  /** Stores a new baseline copy and returns its key. */
  writeCopy(workspaceId: string, bytes: Uint8Array): Promise<string>;
  delete(key: string): Promise<void>;
  compare(baseline: Uint8Array, current: Uint8Array, tolerance: number): Promise<{ verdict: "match" | "shifted" | "changed" | "size_mismatch"; diffPercent: number; shiftDiffPercent?: number; shift?: { x: number; y: number } }>;
}

export const VISUAL_APPROVE_HINT = "If the change is intended, approve it as the new baseline on the run details page.";

/** Runtimes a run may judge with: the server's, or either desktop one (the app picks its own). */
export function runtimesFor(location: "server" | "desktop"): VisualRuntime[] {
  return location === "server" ? ["server"] : ["desktop-mac", "desktop-windows"];
}

/** The runtime a desktop capture was taken on, from its font set id (`fontSetId` starts with the runtime). */
export function runtimeOfRender(location: "server" | "desktop", render: RenderConditions): VisualRuntime | null {
  if (location === "server") return "server";
  const prefix = render.fontSet.split("/")[0];
  return prefix === "desktop-mac" || prefix === "desktop-windows" ? prefix : null;
}

/**
 * Pins the current baseline version of every screenshot step's key (section 4, pinning) and returns the
 * snapshot with `visual` filled in plus the version ids to insert into `RunBaselinePin` once the run exists.
 * Test runs (no saved scenario) have no baseline key and get none.
 */
export async function pinVisualBaselines(
  tx: Tx,
  input: { scenarioId: string | null; environmentId: string; location: "server" | "desktop"; snapshot: RunSnapshot },
): Promise<{ snapshot: RunSnapshot; versionIds: string[] }> {
  const stepIds = input.snapshot.scenario.steps.filter((s) => s.action === "screenshot").map((s) => s.id);
  if (!input.scenarioId || stepIds.length === 0) return { snapshot: input.snapshot, versionIds: [] };
  const device = visualDeviceKey(input.snapshot.device);
  const runtimes = runtimesFor(input.location);
  const rows = await tx.visualBaseline.findMany({
    where: { scenarioId: input.scenarioId, environmentId: input.environmentId, device, runtime: { in: runtimes }, stepId: { in: stepIds } },
    select: { stepId: true, runtime: true, currentVersion: true, versions: { select: { id: true, version: true } } },
  });
  const current = new Map(rows.map((r) => [`${r.stepId}\n${r.runtime}`, r.versions.find((v) => v.version === r.currentVersion)?.id ?? null]));
  const baselines = stepIds.flatMap((stepId) => runtimes.map((runtime) => ({ stepId, runtime, versionId: current.get(`${stepId}\n${runtime}`) ?? null })));
  return { snapshot: { ...input.snapshot, visual: { device, baselines } }, versionIds: baselines.flatMap((b) => (b.versionId ? [b.versionId] : [])) };
}

/** The run's pinned baselines with what the runner needs (worker plan, desktop run message). */
export async function pinnedBaselines(db: Db | Tx, runId: string) {
  const pins = await db.runBaselinePin.findMany({
    where: { runId },
    select: { version: { select: { id: true, storageKey: true, width: true, height: true, render: true, baseline: { select: { stepId: true, environmentId: true, device: true, runtime: true } } } } },
  });
  return pins.flatMap(({ version: v }) => {
    const render = renderConditionsSchema.safeParse(v.render);
    if (!render.success || !(VISUAL_RUNTIMES as readonly string[]).includes(v.baseline.runtime)) return [];
    return [{ versionId: v.id, storageKey: v.storageKey, stepId: v.baseline.stepId, environmentId: v.baseline.environmentId, device: v.baseline.device, runtime: v.baseline.runtime as VisualRuntime, width: v.width, height: v.height, render: render.data }];
  });
}

/** Removes the run's pins; called in the transaction that ends the run, after its step results are written. */
export async function dropRunBaselinePins(tx: Tx, runId: string): Promise<void> {
  await tx.runBaselinePin.deleteMany({ where: { runId } });
}

/**
 * Warning steps the server's own verdict added (first-baseline race), in the final attempt: the run's
 * warning count uses `visualServerVerdict` over the runner's or app's (section 4).
 */
export async function serverVerdictWarnings(tx: Tx, runId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "StepResult"
    WHERE "runId" = ${runId} AND attempt = (SELECT max(attempt) FROM "StepResult" WHERE "runId" = ${runId})
      AND "visualServerVerdict" IN ('changed', 'size_mismatch')
      AND ("visualVerdict" IS NULL OR "visualVerdict" NOT IN ('changed', 'size_mismatch'))`;
  return row?.n ?? 0;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function percent(v: number): string {
  if (v === 0) return "0%";
  if (v < 0.01) return "<0.01%";
  return `${v.toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function visualWarningMessage(r: { verdict: string; diffPercent: number; shiftDiffPercent?: number; expected?: { width: number; height: number } }): string {
  if (r.verdict === "size_mismatch" && r.expected) return `The screenshot size differs from the baseline (${r.expected.width}×${r.expected.height}). ${VISUAL_APPROVE_HINT}`;
  const shifted = r.shiftDiffPercent === undefined ? "" : ` (${percent(r.shiftDiffPercent)} after the shift search)`;
  return `The screenshot differs from the baseline by ${percent(r.diffPercent)}${shifted}. ${VISUAL_APPROVE_HINT}`;
}

type StepRow = {
  id: string;
  runId: string;
  attempt: number;
  index: number;
  stepId: string;
  status: string;
  visualVerdict: VisualVerdict | null;
  visualBaselineVersionId: string | null;
  render: Prisma.JsonValue;
  run: { workspaceId: string; scenarioId: string | null; environmentId: string; location: "server" | "desktop"; comparisonId: string | null; snapshot: Prisma.JsonValue };
};

const STEP_SELECT = {
  id: true, runId: true, attempt: true, index: true, stepId: true, status: true, visualVerdict: true, visualBaselineVersionId: true, render: true,
  run: { select: { workspaceId: true, scenarioId: true, environmentId: true, location: true, comparisonId: true, snapshot: true } },
} as const;

/**
 * Checks a reported verdict against the run's pins (section 4, app verdicts): the version must be pinned for
 * this run and belong to the same workspace and key; `created` needs the key to have had no baseline when the
 * run was pinned. Anything else becomes `skipped`. Returns the corrected verdict.
 */
export async function checkReportedVisualVerdict(db: Db | Tx, stepResultId: string): Promise<VisualVerdict | null> {
  const step = (await db.stepResult.findUnique({ where: { id: stepResultId }, select: STEP_SELECT })) as StepRow | null;
  if (!step?.visualVerdict) return null;
  const ok = await reportedVerdictValid(db, step);
  if (ok) return step.visualVerdict;
  await db.stepResult.update({
    where: { id: step.id },
    data: { visualVerdict: "skipped", visualBaselineVersionId: null, visualDiffPercent: null, visualShiftDiffPercent: null, visualShift: Prisma.DbNull, ...(step.status === "warning" ? { status: "passed", errorCode: null, errorMessage: null } : {}) },
  });
  return "skipped";
}

async function reportedVerdictValid(db: Db | Tx, step: StepRow): Promise<boolean> {
  const { run } = step;
  if (run.comparisonId || !run.scenarioId) return false;
  const render = renderConditionsSchema.safeParse(step.render);
  if (!render.success) return step.visualVerdict === "skipped" && !step.visualBaselineVersionId;
  const runtime = runtimeOfRender(run.location, render.data);
  const snapshot = runSnapshotSchema.safeParse(run.snapshot);
  if (!runtime || !snapshot.success || !snapshot.data.visual) return false;
  const pinned = snapshot.data.visual.baselines.find((b) => b.stepId === step.stepId && b.runtime === runtime);
  if (!pinned) return false;
  if (step.visualVerdict === "created") return pinned.versionId === null && !step.visualBaselineVersionId;
  if (!step.visualBaselineVersionId) return step.visualVerdict === "skipped";
  if (pinned.versionId !== step.visualBaselineVersionId) return false;
  const pin = await db.runBaselinePin.findUnique({
    where: { runId_versionId: { runId: step.runId, versionId: step.visualBaselineVersionId } },
    select: { version: { select: { baseline: { select: { workspaceId: true, scenarioId: true, stepId: true, environmentId: true, device: true, runtime: true } } } } },
  });
  const b = pin?.version.baseline;
  return !!b && b.workspaceId === run.workspaceId && b.scenarioId === run.scenarioId && b.stepId === step.stepId && b.environmentId === run.environmentId && b.device === snapshot.data.visual.device && b.runtime === runtime;
}

/**
 * A step reported `created` (section 4, first baseline): copies its screenshot and makes baseline version 1.
 * The unique key lets one run win; a loser is compared on the server with the winner's version 1 and gets
 * `visualServerVerdict` (and a warning when that says so), so no two runs both claim `created`.
 */
export async function settleCreatedBaseline(db: Db, files: BaselineFiles, stepResultId: string): Promise<VisualVerdict | null> {
  const step = (await db.stepResult.findUnique({ where: { id: stepResultId }, select: STEP_SELECT })) as StepRow | null;
  if (!step || step.visualVerdict !== "created" || step.status !== "passed") return null;
  if (!(await reportedVerdictValid(db, step))) return checkReportedVisualVerdict(db, stepResultId);
  const { run } = step;
  const render = renderConditionsSchema.parse(step.render);
  const runtime = runtimeOfRender(run.location, render)!;
  const device = runSnapshotSchema.parse(run.snapshot).visual!.device;
  const shot = await db.artifact.findFirst({ where: { runId: step.runId, attempt: step.attempt, stepIndex: step.index, kind: "screenshot" }, orderBy: { createdAt: "desc" }, select: { storageKey: true } });
  const skip = async () => {
    await db.stepResult.update({ where: { id: step.id }, data: { visualServerVerdict: "skipped" } });
    return "skipped" as const;
  };
  if (!shot) return skip();
  let bytes: Uint8Array;
  try {
    bytes = await files.read(shot.storageKey);
  } catch {
    return skip();
  }
  const size = pngSize(bytes);
  if (!size) return skip();
  const key = await files.writeCopy(run.workspaceId, bytes);
  const won = await db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "VisualBaseline" (id, "workspaceId", "scenarioId", "stepId", "environmentId", device, runtime, "currentVersion", "updatedAt")
      VALUES (${`vb_${crypto.randomUUID()}`}, ${run.workspaceId}, ${run.scenarioId}, ${step.stepId}, ${run.environmentId}, ${device}, ${runtime}, 1, clock_timestamp())
      ON CONFLICT ("scenarioId", "stepId", "environmentId", device, runtime) DO NOTHING
      RETURNING id`;
    if (!row) return false;
    const version = await tx.visualBaselineVersion.create({
      data: { baselineId: row.id, version: 1, storageKey: key, width: size.width, height: size.height, render, source: "auto", sourceRunId: step.runId, sourceStepResultId: step.id },
      select: { id: true },
    });
    await tx.stepResult.update({ where: { id: step.id }, data: { visualBaselineVersionId: version.id } });
    return true;
  });
  if (won) return "created";
  await files.delete(key).catch(() => {});
  // Lost the race: judge against the winner's first version.
  const winner = await db.visualBaselineVersion.findFirst({
    where: { version: 1, baseline: { scenarioId: run.scenarioId!, stepId: step.stepId, environmentId: run.environmentId, device, runtime } },
    select: { id: true, storageKey: true, width: true, height: true, render: true },
  });
  if (!winner) return skip();
  const winnerRender = renderConditionsSchema.safeParse(winner.render);
  let verdict: VisualVerdict;
  const data: Prisma.StepResultUpdateInput = { visualBaselineVersion: { connect: { id: winner.id } } };
  if (!winnerRender.success) verdict = "skipped";
  else if (renderConditionDiff(winnerRender.data, render).length > 0) verdict = "incomparable";
  else {
    try {
      const tolerance = runSnapshotSchema.parse(run.snapshot).scenario.steps.find((s) => s.id === step.stepId)?.threshold ?? 5;
      const result = await files.compare(await files.read(winner.storageKey), bytes, tolerance);
      verdict = result.verdict;
      data.visualDiffPercent = result.diffPercent;
      if (result.shiftDiffPercent !== undefined) data.visualShiftDiffPercent = result.shiftDiffPercent;
      if (result.shift) data.visualShift = result.shift;
      if (VISUAL_WARNING_VERDICTS.includes(verdict)) {
        data.status = "warning";
        data.errorCode = "warning";
        data.errorMessage = visualWarningMessage({ ...result, expected: { width: winner.width, height: winner.height } });
      }
    } catch {
      verdict = "skipped";
    }
  }
  await db.stepResult.update({ where: { id: step.id }, data: { ...data, visualServerVerdict: verdict } });
  return verdict;
}

export type ApproveResult =
  | { ok: true; versionId: string; version: number; created: boolean }
  | { ok: false; status: 400 | 404 | 409; code: string; message: string };

/**
 * Approves a step result's screenshot as the key's new baseline (section 4, approval). The caller has checked
 * `scenario.write` and the workspace. The baseline row is locked; `expectedVersion` must be its current version
 * (409 otherwise), except that approving the same step result again answers with the version it made.
 */
export async function approveBaseline(db: Db, files: BaselineFiles, input: { workspaceId: string; runId: string; stepResultId: string; expectedVersion: number | null; userId: string }): Promise<ApproveResult> {
  const step = await db.stepResult.findFirst({
    where: { id: input.stepResultId, runId: input.runId, run: { workspaceId: input.workspaceId } },
    select: { ...STEP_SELECT, baselinesSourced: { select: { id: true, version: true, baselineId: true } } },
  });
  if (!step) return { ok: false, status: 404, code: "not_found", message: "Not found" };
  const { run } = step as unknown as StepRow;
  if (run.comparisonId) return { ok: false, status: 409, code: "conflict", message: "Environment comparison runs have no baselines" };
  if (step.status !== "passed" && step.status !== "warning") return { ok: false, status: 409, code: "conflict", message: "Only a passed screenshot step can become a baseline" };
  const render = renderConditionsSchema.safeParse(step.render);
  if (!render.success) return { ok: false, status: 409, code: "conflict", message: "This result has no recorded render conditions" };
  if (!run.scenarioId) return { ok: false, status: 409, code: "conflict", message: "Test runs have no baselines" };
  const shot = await db.artifact.findFirst({ where: { runId: step.runId, attempt: step.attempt, stepIndex: step.index, kind: "screenshot" }, orderBy: { createdAt: "desc" }, select: { storageKey: true } });
  if (!shot) return { ok: false, status: 400, code: "invalid_request", message: "This step has no screenshot" };
  const runtime = runtimeOfRender(run.location, render.data);
  const snapshot = runSnapshotSchema.safeParse(run.snapshot);
  if (!runtime || !snapshot.success) return { ok: false, status: 409, code: "conflict", message: "This result has no recorded render conditions" };
  const device = snapshot.data.visual?.device ?? visualDeviceKey(snapshot.data.device);
  const bytes = await files.read(shot.storageKey);
  const size = pngSize(bytes);
  if (!size) return { ok: false, status: 400, code: "invalid_request", message: "This step has no screenshot" };
  const key = await files.writeCopy(run.workspaceId, bytes);
  try {
    const result = await db.$transaction(async (tx): Promise<ApproveResult> => {
      await tx.$executeRaw`
        INSERT INTO "VisualBaseline" (id, "workspaceId", "scenarioId", "stepId", "environmentId", device, runtime, "currentVersion", "updatedAt")
        VALUES (${`vb_${crypto.randomUUID()}`}, ${run.workspaceId}, ${run.scenarioId}, ${step.stepId}, ${run.environmentId}, ${device}, ${runtime}, 0, clock_timestamp())
        ON CONFLICT ("scenarioId", "stepId", "environmentId", device, runtime) DO NOTHING`;
      const [baseline] = await tx.$queryRaw<{ id: string; currentVersion: number }[]>`
        SELECT id, "currentVersion" FROM "VisualBaseline"
        WHERE "scenarioId" = ${run.scenarioId} AND "stepId" = ${step.stepId} AND "environmentId" = ${run.environmentId} AND device = ${device} AND runtime = ${runtime}
        FOR UPDATE`;
      const current = baseline!.currentVersion;
      const same = step.baselinesSourced.find((v) => v.baselineId === baseline!.id && v.version === current);
      if (same) return { ok: true, versionId: same.id, version: same.version, created: false };
      // Throwing rolls back a baseline row this call may have just inserted.
      if ((input.expectedVersion ?? 0) !== current) throw new ApproveConflict();
      const version = await tx.visualBaselineVersion.create({
        data: { baselineId: baseline!.id, version: current + 1, storageKey: key, width: size.width, height: size.height, render: render.data, source: "approved", approvedById: input.userId, sourceRunId: step.runId, sourceStepResultId: step.id },
        select: { id: true, version: true },
      });
      await tx.visualBaseline.update({ where: { id: baseline!.id }, data: { currentVersion: version.version } });
      return { ok: true, versionId: version.id, version: version.version, created: true };
    });
    if (!result.ok || !result.created) await files.delete(key).catch(() => {});
    return result;
  } catch (err) {
    await files.delete(key).catch(() => {});
    if (err instanceof ApproveConflict) return { ok: false, status: 409, code: "conflict", message: err.message };
    throw err;
  }
}

class ApproveConflict extends Error {
  constructor() {
    super("The baseline was changed in the meantime. Reload and try again.");
  }
}
