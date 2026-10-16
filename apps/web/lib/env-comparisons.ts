// Environment comparison (stage 7 contract section 6): start, choices, list, detail, compare again, cancel.
import {
  cancelComparison,
  ComparisonStartError,
  createEnvComparison,
  RunCreateError,
  recompareComparison,
  runComparisonJob,
  type Prisma,
} from "@defe2end/db";
import { COMPARISON_VERDICTS, DESKTOP_TIMINGS, missingCapabilities, SCREEN_FEATURES } from "@defe2end/shared";
import { z } from "zod";
import { ApiError } from "./api";
import { getDb } from "./db";
import { getStorage, minFreeDiskBytes } from "./storage";

export const startComparisonSchema = z.strictObject({
  scenarioId: z.string().min(1),
  leftEnvironmentId: z.string().min(1),
  rightEnvironmentId: z.string().min(1),
  location: z.enum(["server", "desktop"]).default("server"),
  deviceId: z.string().min(1).optional(),
  tolerance: z.number().min(0).max(100).optional(),
});

export const recompareSchema = z.strictObject({ tolerance: z.number().min(0).max(100).optional() });

export async function startComparison(workspaceId: string, userId: string, body: z.infer<typeof startComparisonSchema>) {
  try {
    return await createEnvComparison(getDb(), { workspaceId, userId, ...body }, { freeBytes: () => getStorage().freeBytes(), minFreeBytes: minFreeDiskBytes });
  } catch (err) {
    if (err instanceof ComparisonStartError) throw new ApiError("invalid_request", "The comparison can't start", { reasons: err.reasons });
    if (err instanceof RunCreateError) {
      // The app checks are start checks too: a list of reasons, 400.
      if (err.code === "desktop_not_connected" || err.code === "app_update_required") throw new ApiError("invalid_request", err.message, { reasons: [err.code], ...err.details });
      throw new ApiError(err.code, err.message, err.details);
    }
    throw err;
  }
}

/** What the start form needs: the site's environments, a default pair, and whether it can run at all. */
export async function comparisonChoices(workspaceId: string, userId: string, scenarioId: string) {
  const db = getDb();
  const scenario = await db.scenario.findFirst({ where: { id: scenarioId, workspaceId }, select: { siteId: true, steps: true } });
  if (!scenario) throw ApiError.notFound();
  const environments = await db.environment.findMany({ where: { workspaceId, siteId: scenario.siteId }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, baseUrl: true, useAuthSession: true } });
  const sessions = await db.authSession.findMany({ where: { userId, environmentId: { in: environments.map((e) => e.id) }, expiresAt: { gt: new Date() } }, select: { environmentId: true } });
  const withSession = new Set(sessions.map((s) => s.environmentId));
  const device = await db.desktopDevice.findFirst({
    where: { userId, connectionId: { not: null }, lastSeenAt: { gt: new Date(Date.now() - DESKTOP_TIMINGS.onlineWindowMs) } },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, label: true, capabilities: true },
  });
  const recent = await db.envComparison.findMany({ where: { workspaceId, scenarioId }, orderBy: { createdAt: "desc" }, take: 5, select: listSelect });
  return {
    environments: environments.map((e) => ({ id: e.id, name: e.name, baseUrl: e.baseUrl, useAuthSession: e.useAuthSession, hasOwnSession: withSession.has(e.id) })),
    defaultLeftId: environments[0]?.id ?? null,
    defaultRightId: environments[1]?.id ?? null,
    hasScreenshotStep: Array.isArray(scenario.steps) && (scenario.steps as { action?: string }[]).some((s) => s.action === "screenshot"),
    desktop: device ? { id: device.id, label: device.label, missing: missingCapabilities([SCREEN_FEATURES.a11ySnapshot, SCREEN_FEATURES.masking], device.capabilities) } : null,
    recent: recent.map(toListItem),
  };
}

const listSelect = {
  id: true,
  status: true,
  round: true,
  location: true,
  tolerance: true,
  screenVerdict: true,
  structureVerdict: true,
  createdAt: true,
  finishedAt: true,
  scenario: { select: { id: true, name: true } },
  site: { select: { id: true, name: true } },
  leftEnvironment: { select: { id: true, name: true } },
  rightEnvironment: { select: { id: true, name: true } },
} satisfies Prisma.EnvComparisonSelect;

type ListRow = Prisma.EnvComparisonGetPayload<{ select: typeof listSelect }>;

function toListItem(r: ListRow) {
  return { ...r, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null };
}

export const listComparisonsQuerySchema = z.object({
  verdict: z.enum(COMPARISON_VERDICTS).optional(),
  scenario: z.string().max(200).optional(),
  siteId: z.string().optional(),
  location: z.enum(["server", "desktop"]).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function listComparisons(workspaceId: string, query: z.infer<typeof listComparisonsQuerySchema>) {
  const where: Prisma.EnvComparisonWhereInput = {
    workspaceId,
    ...(query.siteId ? { siteId: query.siteId } : {}),
    ...(query.location ? { location: query.location } : {}),
    ...(query.scenario ? { scenario: { name: { contains: query.scenario, mode: "insensitive" } } } : {}),
    // A verdict filter matches either kind (screen or structure).
    ...(query.verdict ? { OR: [{ screenVerdict: query.verdict }, { structureVerdict: query.verdict }] } : {}),
    ...(query.from || query.to
      ? { createdAt: { ...(query.from ? { gte: new Date(`${query.from}T00:00:00Z`) } : {}), ...(query.to ? { lt: new Date(new Date(`${query.to}T00:00:00Z`).getTime() + 86_400_000) } : {}) } }
      : {}),
  };
  const rows = await getDb().envComparison.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit, select: listSelect });
  return { comparisons: rows.map(toListItem) };
}

export async function getComparisonDetail(workspaceId: string, id: string) {
  const db = getDb();
  const row = await db.envComparison.findFirst({
    where: { id, workspaceId },
    select: {
      ...listSelect,
      leftBaseUrl: true,
      rightBaseUrl: true,
      conditions: true,
      error: true,
      deviceId: true,
      runs: { select: { id: true, comparisonSide: true, status: true, startedAt: true, finishedAt: true, errorMessage: true } },
    },
  });
  if (!row) throw ApiError.notFound();
  const steps = await db.envComparisonStep.findMany({
    where: { comparisonId: id, round: row.round },
    include: {
      leftStepResult: { select: { startedAt: true, render: true, index: true } },
      rightStepResult: { select: { startedAt: true, render: true, index: true } },
    },
  });
  const conditions = row.conditions as { steps?: { id: string; action: string; value?: string; mask?: string[] }[]; masking?: { enabled: boolean; selectors: string } };
  const order = new Map((conditions.steps ?? []).map((s, i) => [s.id, i]));
  steps.sort((a, b) => (order.get(a.stepId) ?? 0) - (order.get(b.stepId) ?? 0));
  const files = await db.envComparisonFile.findMany({ where: { comparisonId: id, round: row.round }, select: { id: true, storageKey: true } });
  const fileId = new Map(files.map((f) => [f.storageKey, f.id]));
  const shots = await db.artifact.findMany({
    where: { runId: { in: row.runs.map((r) => r.id) }, kind: "screenshot" },
    orderBy: { createdAt: "asc" },
    select: { id: true, runId: true, stepIndex: true },
  });
  const shotOf = (runId: string | undefined, index: number | undefined) => shots.filter((s) => s.runId === runId && s.stepIndex === index).at(-1)?.id ?? null;
  const leftRun = row.runs.find((r) => r.comparisonSide === "left");
  const rightRun = row.runs.find((r) => r.comparisonSide === "right");
  return {
    ...toListItem(row),
    leftBaseUrl: row.leftBaseUrl,
    rightBaseUrl: row.rightBaseUrl,
    error: row.error,
    masking: conditions.masking ?? null,
    runs: row.runs.map((r) => ({ ...r, startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null })),
    steps: steps.map((s) => {
      const stepDef = (conditions.steps ?? []).find((d) => d.id === s.stepId);
      return {
        stepId: s.stepId,
        name: stepDef?.value ?? s.stepId,
        mask: stepDef?.mask ?? [],
        screenVerdict: s.screenVerdict,
        screenDiffPercent: s.screenDiffPercent,
        screenShiftDiffPercent: s.screenShiftDiffPercent,
        screenShift: s.screenShift,
        screenTolerance: s.screenTolerance,
        structureVerdict: s.structureVerdict,
        structureCounts: s.structureMoved === null ? null : { moved: s.structureMoved, added: s.structureAdded, removed: s.structureRemoved, changed: s.structureChanged },
        reason: s.reason,
        screenDiffFileId: s.screenDiffKey ? (fileId.get(s.screenDiffKey) ?? null) : null,
        structureDiffFileId: s.structureDiffKey ? (fileId.get(s.structureDiffKey) ?? null) : null,
        left: { runId: leftRun?.id ?? null, artifactId: shotOf(leftRun?.id, s.leftStepResult?.index), capturedAt: s.leftStepResult?.startedAt.toISOString() ?? null, render: s.leftStepResult?.render ?? null },
        right: { runId: rightRun?.id ?? null, artifactId: shotOf(rightRun?.id, s.rightStepResult?.index), capturedAt: s.rightStepResult?.startedAt.toISOString() ?? null, render: s.rightStepResult?.render ?? null },
      };
    }),
  };
}

/** A file the comparison wrote, of its current round. */
export async function comparisonFile(workspaceId: string, comparisonId: string, fileId: string) {
  const file = await getDb().envComparisonFile.findFirst({ where: { id: fileId, comparisonId, comparison: { workspaceId } }, select: { storageKey: true, kind: true } });
  if (!file) throw ApiError.notFound();
  return { stream: await getStorage().get(file.storageKey), contentType: file.kind === "screen_diff" ? "image/png" : "application/json" };
}

export async function recompare(workspaceId: string, id: string, tolerance: number | undefined) {
  const result = await recompareComparison(getDb(), workspaceId, id, tolerance);
  if (!result.ok) throw new ApiError(result.code, result.message);
  // Runs here in the background; if this process dies the worker re-claims it once the claim expires.
  void runComparisonJob(getDb(), getStorage(), result.claim!).catch((err: Error) => console.error("comparison failed", err.message));
}

export async function cancel(workspaceId: string, id: string, userId: string) {
  const result = await cancelComparison(getDb(), workspaceId, id, userId);
  if (!result.ok) throw new ApiError(result.code, result.message);
}
