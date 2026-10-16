// Creating runs (stage 3 contract sections 3 and 4.4). Single runs, groups, pre-save test runs and "re-run
// failed" all go through `createRuns`: one short transaction holding the workspace run lock, so the queue
// limit holds under concurrent requests and a group is created whole or not at all.
import { buildSnapshot, createRunsInTx as createRunsCore, findEnvironment, findScenarios, hashRequest, RunCreateError, resolveScenarioRuns as resolveScenarioRunsCore, scenarioRun, lockWorkspaceRuns, type CreatedRuns, type CreateRunsInput, type Prisma, type RunSpec } from "@defe2end/db";
import { RUN_LIMITS, runOptionsSchema, stepsSchema, type RunTrigger } from "@defe2end/shared";
import { z } from "zod";
import { ApiError } from "./api";
import { getDb } from "./db";
import { getStorage, minFreeDiskBytes } from "./storage";

type Tx = Prisma.TransactionClient;

const placementFields = {
  location: z.enum(["server", "desktop"]).default("server"),
  deviceId: z.string().min(1).optional(),
};

export const createRunSchema = z.strictObject({
  ...placementFields,
  scenarioId: z.string().min(1),
  environmentId: z.string().min(1),
  options: runOptionsSchema.default({}),
});
export type CreateRunRequest = z.infer<typeof createRunSchema>;

/** Pre-save test run: the editor's unsaved steps, validated like saved ones. */
export const createTestRunSchema = z.strictObject({
  ...placementFields,
  /** The saved scenario whose editor runs it, for its "last test run"; the run itself stays out of its history. */
  scenarioId: z.string().min(1).optional(),
  environmentId: z.string().min(1),
  steps: stepsSchema,
  options: runOptionsSchema.default({}),
});
export type CreateTestRunRequest = z.infer<typeof createTestRunSchema>;

export const createGroupSchema = z.strictObject({
  ...placementFields,
  environmentId: z.string().min(1),
  /** Order = `groupIndex` (the run order of a sequential group). */
  scenarioIds: z.array(z.string().min(1)).min(1).max(RUN_LIMITS.workspaceQueueLength),
  mode: z.enum(["sequential", "parallel"]),
  continueOnFailure: z.boolean(),
  options: runOptionsSchema.default({}),
});
export type CreateGroupRequest = z.infer<typeof createGroupSchema>;

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const idempotencyKeySchema = z.string().trim().min(1).max(200);

/** The `Idempotency-Key` header, if any; malformed → 400. */
export function readIdempotencyKey(request: Request): string | undefined {
  const raw = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (raw === null) return undefined;
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) throw new ApiError("invalid_request", "Idempotency-Key must be 1–200 characters");
  return parsed.data;
}

/** Shown as the scenario name of a pre-save test run. */
export const TEST_RUN_NAME = "Test run";
const TEST_RUN_TRIGGER: RunTrigger = "test";

export { AUTH_SESSION_MISSING_MESSAGE, DESKTOP_NOT_CONNECTED_MESSAGE, RUN_VARIABLE_MISSING_MESSAGE as VARIABLE_MISSING_MESSAGE, runCapabilities, type CreateRunsInput, type RunSpec } from "@defe2end/db";

async function createRuns(input: CreateRunsInput): Promise<CreatedRuns> {
  return getDb().$transaction((tx) => createRunsInTx(tx, input));
}

/** The shared creation path with this process's storage; its refusals become API errors. */
export async function createRunsInTx(tx: Tx, input: CreateRunsInput): Promise<CreatedRuns> {
  return asApiError(() => createRunsCore(tx, input, { freeBytes: () => getStorage().freeBytes(), minFreeBytes: minFreeDiskBytes }));
}

/** Saved scenarios of one environment's site as run specs (scheduler and API reuse it). */
export async function resolveScenarioRuns(tx: Tx, workspaceId: string, environmentId: string, scenarioIds: string[]): Promise<{ environmentId: string; runs: RunSpec[] }> {
  return asApiError(() => resolveScenarioRunsCore(tx, workspaceId, environmentId, scenarioIds));
}

async function asApiError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RunCreateError) throw new ApiError(err.code, err.message, err.details);
    throw err;
  }
}

/** A scenario run: saved scenario + environment of the same site. */
export async function createRun(input: {
  workspaceId: string;
  actorId: string;
  trigger: Exclude<RunTrigger, "test">;
  request: CreateRunRequest;
  idempotencyKey?: string;
}): Promise<{ runId: string; created: boolean }> {
  const { request } = input;
  const result = await createRuns({
    ...input,
    subject: { kind: "user", userId: input.actorId },
    requestHash: hashRequest([input.trigger, request.scenarioId, request.environmentId, request.options]),
    options: request.options,
    placement: request,
    async resolve(tx) {
      const environment = await findEnvironment(tx, input.workspaceId, request.environmentId);
      const [scenario] = await findScenarios(tx, input.workspaceId, [request.scenarioId], environment.siteId);
      return { environmentId: environment.id, runs: [await scenarioRun(tx, input.workspaceId, scenario!, environment)] };
    },
  });
  return { runId: result.runIds[0]!, created: result.created };
}

/** Pre-save test run (`trigger: test`, no scenario). Kept 24 hours after it ends, then deleted with its files. */
export async function createTestRun(input: {
  workspaceId: string;
  actorId: string;
  request: CreateTestRunRequest;
  idempotencyKey?: string;
}): Promise<{ runId: string; created: boolean }> {
  const { request } = input;
  const result = await createRuns({
    ...input,
    subject: { kind: "user", userId: input.actorId },
    trigger: TEST_RUN_TRIGGER,
    requestHash: hashRequest([TEST_RUN_TRIGGER, request.environmentId, request.steps, request.options, ...(request.scenarioId ? [request.scenarioId] : [])]),
    options: request.options,
    placement: request,
    async resolve(tx) {
      const environment = await findEnvironment(tx, input.workspaceId, request.environmentId);
      // Another workspace's (or a missing) scenario id is a 404, like every id in a request.
      if (request.scenarioId && !(await tx.scenario.findFirst({ where: { id: request.scenarioId, workspaceId: input.workspaceId }, select: { id: true } }))) throw ApiError.notFound();
      const snapshot = await buildSnapshot(tx, input.workspaceId, { id: null, name: TEST_RUN_NAME, steps: request.steps }, environment);
      return { environmentId: environment.id, runs: [{ scenarioId: null, testOfScenarioId: request.scenarioId ?? null, snapshot }] };
    },
  });
  return { runId: result.runIds[0]!, created: result.created };
}

/** A group: one environment, scenarios of its site, created with all children in one transaction. */
export async function createGroupRun(input: {
  workspaceId: string;
  actorId: string;
  request: CreateGroupRequest;
  idempotencyKey?: string;
}): Promise<{ groupRunId: string; runIds: string[]; created: boolean }> {
  const { request } = input;
  const result = await createRuns({
    ...input,
    subject: { kind: "user", userId: input.actorId },
    trigger: "manual",
    requestHash: hashRequest(["group", request.environmentId, request.scenarioIds, request.mode, request.continueOnFailure, request.options]),
    options: request.options,
    placement: request,
    group: { environmentId: request.environmentId, mode: request.mode, continueOnFailure: request.continueOnFailure },
    async resolve(tx) {
      const environment = await findEnvironment(tx, input.workspaceId, request.environmentId);
      const scenarios = await findScenarios(tx, input.workspaceId, request.scenarioIds, environment.siteId);
      const runs: RunSpec[] = [];
      for (const scenario of scenarios) runs.push(await scenarioRun(tx, input.workspaceId, scenario, environment));
      return { environmentId: environment.id, runs };
    },
  });
  return { groupRunId: result.groupRunId!, runIds: result.runIds, created: result.created };
}

/**
 * "Re-run failed only": a new group of the `failed`, `error` and `timed_out` children, same environment, mode
 * continueOnFailure and run options, with the scenarios as they are now. The old group's results don't change.
 */
export async function rerunFailed(input: { workspaceId: string; actorId: string; groupRunId: string; idempotencyKey?: string }) {
  const group = await getDb().groupRun.findFirst({
    where: { id: input.groupRunId, workspaceId: input.workspaceId },
    include: { runs: { where: { status: { in: ["failed", "error", "timed_out"] } }, orderBy: { groupIndex: "asc" }, select: { scenarioId: true, options: true } } },
  });
  if (!group) throw ApiError.notFound();
  if (group.status === "queued" || group.status === "running") throw new ApiError("conflict", "This group is still running. Re-run its failed runs once it has finished.");
  if (!group.environmentId) throw new ApiError("conflict", "The group's environment was deleted.");
  const scenarioIds = group.runs.flatMap((r) => (r.scenarioId ? [r.scenarioId] : []));
  if (scenarioIds.length === 0) throw new ApiError("conflict", "No failed runs of this group can be run again.");
  return createGroupRun({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    // The group's children share the options they were requested with.
    request: { location: group.location, deviceId: group.desktopDeviceId ?? undefined, environmentId: group.environmentId, scenarioIds, mode: group.mode, continueOnFailure: group.continueOnFailure, options: runOptionsSchema.parse(group.runs[0]!.options ?? {}) },
  });
}

export const RESOURCE_IN_USE_BY_RUNS = "Runs that are waiting or running use this. Wait for them to finish or cancel them first.";

/**
 * Contract section 2: what a queued or running run uses can't be deleted (finished runs keep their snapshot).
 * Call first in the deleting transaction: the workspace run lock makes a run created meanwhile visible.
 */
export async function assertNoActiveRuns(tx: Prisma.TransactionClient, workspaceId: string, where: Prisma.RunWhereInput): Promise<void> {
  await lockWorkspaceRuns(tx, workspaceId);
  const active = await tx.run.count({ where: { ...where, workspaceId, status: { in: ["queued", "running"] } } });
  if (active > 0) throw new ApiError("conflict", RESOURCE_IN_USE_BY_RUNS);
}
