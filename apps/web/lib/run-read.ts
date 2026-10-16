// Reading runs (stage 3 contract section 7): detail, filtered list, scenario history, "changed since last
// pass", artifacts. Every query is scoped to the checked workspace, so another workspace's id is a plain 404.
import type { Prisma } from "@defe2end/db";
import {
  ARTIFACT_CONTENT_TYPES,
  RUN_STATUSES,
  RUN_TRIGGERS,
  type ArtifactKind,
  type RunSnapshot,
  type RunStatus,
  type RunTrigger,
  STEP_MAX_ATTEMPTS,
  type Step,
  type StepResultStatus,
} from "@defe2end/shared";
import { z } from "zod";
import { ApiError } from "./api";
import { getDb } from "./db";
import { computeRunChanges, type ComparableRun, type RunChange } from "./run-changes";

const runInclude = {
  desktopDevice: { select: { label: true } },
  stepResults: { orderBy: { index: "asc" } },
  artifacts: { orderBy: { createdAt: "asc" } },
  requestedBy: { select: { name: true } },
} satisfies Prisma.RunInclude;

const summarySelect = {
  id: true,
  status: true,
  cancelRequestedAt: true,
  trigger: true,
  scenarioId: true,
  environmentId: true,
  groupRunId: true,
  errorCode: true,
  snapshot: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
  requestedBy: { select: { name: true } },
} satisfies Prisma.RunSelect;

type RunRow = Prisma.RunGetPayload<{ include: typeof runInclude }>;
type SummaryRow = Prisma.RunGetPayload<{ select: typeof summarySelect }>;

export interface RunSummary {
  id: string;
  status: RunStatus;
  /** Cancel accepted but not final yet (the run may still end otherwise). */
  cancelRequested: boolean;
  trigger: RunTrigger;
  scenarioId: string | null;
  scenarioName: string;
  environmentId: string | null;
  environmentName: string;
  groupRunId: string | null;
  requestedByName: string | null;
  errorCode: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** From start to finish; null until finished. */
  durationMs: number | null;
}

export interface RunStepView {
  index: number;
  stepId: string;
  action: Step["action"];
  /** As written in the scenario (`{{KEY}}` templates, never values). */
  name?: string;
  selector?: string;
  url?: string;
  value?: string;
  expected?: string;
  /** Tries per step: the first plus one fixed retry (spec 2.9). */
  maxAttempts: number;
  /** Null until the step finished (or when the run ended before it). */
  result: {
    status: StepResultStatus;
    attempts: number;
    startedAt: string;
    durationMs: number;
    errorCode: string | null;
    errorMessage: string | null;
    expected: string | null;
    actual: string | null;
    /** A changing action was repeated without undoing the page (contract section 1). Set by the runner. */
    possibleDuplicate: boolean;
  } | null;
}

export interface ArtifactView {
  id: string;
  kind: ArtifactKind;
  stepIndex: number | null;
  /** Whole-run attempt (spec 4.3), 1 when the row doesn't say. */
  attempt: number;
  name: string;
  sizeBytes: number;
  url: string;
}

export interface RunDetail extends RunSummary {
  cancelRequestedAt: string | null;
  errorMessage: string | null;
  runnerVersion: string | null;
  browserVersion: string | null;
  workerId: string | null;
  /** `desktop`: ran on the requester's PC (`deviceLabel`, null once the device is gone). */
  location: "server" | "desktop";
  deviceLabel: string | null;
  baseUrl: string;
  /** Steps of the latest whole-run attempt. */
  steps: RunStepView[];
  artifacts: ArtifactView[];
  /** Whole-run attempts so far (spec 4.3); 2 when the run was retried. */
  attemptCount: number;
  /** Steps of earlier attempts, oldest first. */
  previousAttempts: { attempt: number; steps: RunStepView[] }[];
  /** `warning` steps in the latest attempt (spec 4.2). */
  warningCount: number;
  /** Final verdict `passed` after an earlier failed attempt. */
  passedAfterRetry: boolean;
}

// The attempt columns arrive with the worker merge; read them defensively until then.
const attemptOf = (row: object) => (row as { attempt?: number | null }).attempt ?? 1;

function durationOf(startedAt: Date | null, finishedAt: Date | null): number | null {
  return startedAt && finishedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : null;
}

function toSummary(row: SummaryRow | RunRow): RunSummary {
  const snapshot = row.snapshot as RunSnapshot;
  return {
    id: row.id,
    status: row.status,
    cancelRequested: row.cancelRequestedAt !== null && (row.status === "queued" || row.status === "running"),
    trigger: row.trigger,
    scenarioId: row.scenarioId,
    scenarioName: snapshot.scenario.name,
    environmentId: row.environmentId,
    environmentName: snapshot.environment.name,
    groupRunId: row.groupRunId,
    requestedByName: row.requestedBy?.name ?? null,
    errorCode: row.errorCode,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: durationOf(row.startedAt, row.finishedAt),
  };
}

export function artifactUrl(slug: string, runId: string, artifactId: string): string {
  return `/api/w/${slug}/runs/${runId}/artifacts/${artifactId}`;
}

function toDetail(slug: string, row: RunRow): RunDetail {
  const snapshot = row.snapshot as RunSnapshot;
  const attemptCount = Math.max(1, ...row.stepResults.map(attemptOf), ...row.artifacts.map(attemptOf));
  const stepsOf = (attempt: number): RunStepView[] => {
    const results = new Map(row.stepResults.filter((r) => attemptOf(r) === attempt).map((r) => [r.index, r]));
    return snapshot.scenario.steps.map((step, index) => {
      const r = results.get(index);
      return {
        index,
        stepId: step.id,
        action: step.action,
        name: step.name,
        selector: step.selector,
        url: step.url,
        value: step.value,
        expected: step.expected,
        maxAttempts: STEP_MAX_ATTEMPTS,
        result: r
          ? {
              status: r.status,
              attempts: r.attempts,
              startedAt: r.startedAt.toISOString(),
              durationMs: r.durationMs,
              errorCode: r.errorCode,
              errorMessage: r.errorMessage,
              expected: r.expected,
              actual: r.actual,
              possibleDuplicate: (r as { possibleDuplicate?: boolean }).possibleDuplicate ?? false,
            }
          : null,
      };
    });
  };
  const steps = stepsOf(attemptCount);
  const warningCount = (row as { warningCount?: number | null }).warningCount ?? steps.filter((s) => (s.result?.status as string) === "warning").length;
  return {
    ...toSummary(row),
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    errorMessage: row.errorMessage,
    runnerVersion: row.runnerVersion,
    browserVersion: row.browserVersion,
    workerId: row.workerId,
    location: row.location,
    deviceLabel: row.desktopDevice?.label ?? null,
    baseUrl: snapshot.environment.baseUrl,
    steps,
    attemptCount,
    previousAttempts: Array.from({ length: attemptCount - 1 }, (_, i) => ({ attempt: i + 1, steps: stepsOf(i + 1) })),
    warningCount,
    passedAfterRetry: row.status === "passed" && attemptCount > 1,
    artifacts: row.artifacts.map((a) => ({ id: a.id, kind: a.kind, stepIndex: a.stepIndex, attempt: attemptOf(a), name: a.name, sizeBytes: a.sizeBytes, url: artifactUrl(slug, row.id, a.id) })),
  };
}

/** Null when the run isn't in this workspace (or doesn't exist). */
export async function findRunDetail(workspace: { id: string; slug: string }, runId: string): Promise<RunDetail | null> {
  const row = await getDb().run.findFirst({ where: { id: runId, workspaceId: workspace.id }, include: runInclude });
  return row ? toDetail(workspace.slug, row) : null;
}

/** Scoped to the checked workspace: another workspace's run id is a plain 404. */
export async function getRunDetail(workspace: { id: string; slug: string }, runId: string): Promise<RunDetail> {
  const detail = await findRunDetail(workspace, runId);
  if (!detail) throw ApiError.notFound();
  return detail;
}

// --- Lists -------------------------------------------------------------------------

const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" || v === null ? undefined : v), schema.optional());

export const listRunsQuerySchema = z.object({
  scenarioId: optional(z.string().min(1).max(64)),
  environmentId: optional(z.string().min(1).max(64)),
  status: optional(z.enum(RUN_STATUSES)),
  trigger: optional(z.enum(RUN_TRIGGERS)),
  page: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(1).max(100_000).default(1)),
  limit: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(1).max(100).default(50)),
});
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

export const LIST_QUERY_KEYS = ["scenarioId", "environmentId", "status", "trigger", "page", "limit"] as const;

/** From URL search params (API) or Next.js `searchParams` (pages). Invalid values → 400 / ignored by the page. */
export function readListQuery(source: URLSearchParams | Record<string, string | string[] | undefined>): ListRunsQuery {
  const get = (key: string) => (source instanceof URLSearchParams ? source.get(key) : [source[key]].flat()[0]) ?? undefined;
  return listRunsQuerySchema.parse(Object.fromEntries(LIST_QUERY_KEYS.map((k) => [k, get(k)])));
}

export interface RunList {
  runs: RunSummary[];
  total: number;
  page: number;
  limit: number;
}

export async function listRuns(workspaceId: string, query: ListRunsQuery): Promise<RunList> {
  const where: Prisma.RunWhereInput = {
    workspaceId,
    scenarioId: query.scenarioId,
    environmentId: query.environmentId,
    status: query.status,
    trigger: query.trigger,
  };
  const [rows, total] = await Promise.all([
    getDb().run.findMany({ where, orderBy: [{ queuedAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * query.limit, take: query.limit, select: summarySelect }),
    getDb().run.count({ where }),
  ]);
  return { runs: rows.map(toSummary), total, page: query.page, limit: query.limit };
}

/** The scenario page's history strip: the latest runs of a scenario, oldest first. */
export async function scenarioHistory(workspaceId: string, scenarioId: string, take = 24): Promise<RunSummary[]> {
  const rows = await getDb().run.findMany({ where: { workspaceId, scenarioId }, orderBy: [{ queuedAt: "desc" }, { id: "desc" }], take, select: summarySelect });
  return rows.map(toSummary).reverse();
}

// --- Changed since last pass ---------------------------------------------------------

/** How many earlier passes give a step its usual duration. */
const RECENT_PASSES = 5;

export interface RunChangesView {
  /** The latest earlier pass of the same scenario on the same environment; null when there is none. */
  baseline: { id: string; finishedAt: string | null; trigger: RunTrigger } | null;
  changes: RunChange[];
}

function comparable(row: { id: string; snapshot: unknown; runnerVersion: string | null; browserVersion: string | null; stepResults: { index: number; status: StepResultStatus; durationMs: number }[] }): ComparableRun {
  const snapshot = row.snapshot as RunSnapshot;
  const results = new Map(row.stepResults.map((r) => [r.index, r]));
  return {
    id: row.id,
    baseUrl: snapshot.environment.baseUrl,
    runnerVersion: row.runnerVersion,
    browserVersion: row.browserVersion,
    steps: snapshot.scenario.steps.map((s, index) => ({
      index,
      stepId: s.id,
      action: s.action,
      target: s.selector ?? s.url,
      value: s.value ?? s.expected,
      options: s.timeout === undefined && !s.optional ? undefined : { timeout: s.timeout, optional: s.optional },
      status: results.get(index)?.status ?? null,
      durationMs: results.get(index)?.durationMs ?? null,
    })),
  };
}

/**
 * Null for runs without a scenario or environment to compare against (test runs, deleted originals).
 * Only earlier runs count: a re-run of an old run never compares with a later pass.
 */
export async function getRunChanges(workspaceId: string, runId: string): Promise<RunChangesView | null> {
  const db = getDb();
  const select = { id: true, snapshot: true, runnerVersion: true, browserVersion: true, status: true, trigger: true, finishedAt: true, scenarioId: true, environmentId: true, queuedAt: true, stepResults: { select: { index: true, status: true, durationMs: true } } } satisfies Prisma.RunSelect;
  const current = await db.run.findFirst({ where: { id: runId, workspaceId }, select });
  if (!current?.scenarioId || !current.environmentId) return null;
  const passes = await db.run.findMany({
    where: { workspaceId, scenarioId: current.scenarioId, environmentId: current.environmentId, status: "passed", id: { not: current.id }, queuedAt: { lt: current.queuedAt } },
    orderBy: [{ queuedAt: "desc" }, { id: "desc" }],
    take: RECENT_PASSES,
    select,
  });
  const baseline = passes[0];
  if (!baseline) return { baseline: null, changes: [] };
  const finished = current.status !== "queued" && current.status !== "running";
  return {
    baseline: { id: baseline.id, finishedAt: baseline.finishedAt?.toISOString() ?? null, trigger: baseline.trigger },
    changes: computeRunChanges(comparable(current), comparable(baseline), passes.map(comparable), finished),
  };
}

// --- Artifacts -----------------------------------------------------------------------

/** Workspace, run and artifact must all match; the content type is fixed by kind, never taken from the file. */
export async function findArtifact(workspaceId: string, runId: string, artifactId: string) {
  const artifact = await getDb().artifact.findFirst({ where: { id: artifactId, runId, workspaceId } });
  if (!artifact) throw ApiError.notFound();
  return { ...artifact, contentType: ARTIFACT_CONTENT_TYPES[artifact.kind] };
}

// --- Group runs ----------------------------------------------------------------------

export interface GroupRunView {
  id: string;
  status: RunStatus;
  mode: "sequential" | "parallel";
  continueOnFailure: boolean;
  environmentId: string | null;
  createdAt: string;
  finishedAt: string | null;
  runs: (RunSummary & { groupIndex: number | null })[];
}

export async function getGroupRun(workspaceId: string, groupId: string): Promise<GroupRunView | null> {
  const group = await getDb().groupRun.findFirst({
    where: { id: groupId, workspaceId },
    include: { runs: { orderBy: [{ groupIndex: "asc" }, { id: "asc" }], select: { ...summarySelect, groupIndex: true } } },
  });
  if (!group) return null;
  return {
    id: group.id,
    status: group.status,
    mode: group.mode,
    continueOnFailure: group.continueOnFailure,
    environmentId: group.environmentId,
    createdAt: group.createdAt.toISOString(),
    finishedAt: group.finishedAt?.toISOString() ?? null,
    runs: group.runs.map((r) => ({ ...toSummary(r), groupIndex: r.groupIndex })),
  };
}
