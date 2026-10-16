// The run creation core (stage 3 contract sections 3 and 4.4, stage 5 section 3), shared by the web app and
// the worker's scheduler: inside a caller's transaction holding the workspace run lock. Refusals throw
// `RunCreateError` with an API error code; the web app turns them into its API errors. The free-disk check is
// passed in, so each process asks its own storage.
import { createHash } from "node:crypto";
import { can, DEFAULT_DEVICE, DESKTOP_TIMINGS, MASKING_POLICY_VERSION, missingCapabilities, RUN_LIMITS, splitSelectorList, runSnapshotSchema, screenQualityCapabilities, stepsSchema, uploadAttachmentRefs, type RunSnapshot, type RunTrigger, type Step } from "@defe2end/shared";
import type { Prisma } from "./generated/prisma/client.js";
import { lockWorkspaceRuns } from "./runs.js";
import { missingPersonalVariables, subjectAuthSession, type ValueSubject } from "./variables.js";

type Tx = Prisma.TransactionClient;

export type RunCreateErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "idempotency_conflict"
  | "queue_full"
  | "storage_low"
  | "desktop_not_connected"
  | "app_update_required"
  | "auth_session_missing"
  | "variable_missing";

export class RunCreateError extends Error {
  constructor(
    readonly code: RunCreateErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  static notFound(): RunCreateError {
    return new RunCreateError("not_found", "Not found");
  }
}

/** Where the run goes (stage 4 contract section 4.1). `deviceId`: one of the requester's online devices; unset = most recent. */
export type Placement = { location: "server" | "desktop"; deviceId?: string };

/** The caller's storage: new runs pause below `minFreeBytes`. */
export interface RunCreateEnv {
  freeBytes(): Promise<number>;
  minFreeBytes(): number;
}

export function hashRequest(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export interface RunSpec {
  scenarioId: string | null;
  /** Test runs started from a saved scenario's editor (scenarioId stays null). */
  testOfScenarioId?: string | null;
  snapshot: RunSnapshot;
}

export interface CreatedRuns {
  runIds: string[];
  groupRunId: string | null;
  created: boolean;
}

/**
 * The single creation path. Order inside the transaction: workspace run lock → requester re-read (active,
 * still allowed) → idempotency key → `resolve` (inputs belong to this workspace) → queue length (a group
 * counts all its children) and free disk → insert. A repeated key with the same request returns what it
 * created before, never refused by the queue or disk limits. A group keeps its key on its first child.
 */
export interface CreateRunsInput {
  workspaceId: string;
  /** Whose own values and login session the runs use; unattended subjects leave requestedById null. */
  subject: ValueSubject;
  trigger: RunTrigger;
  idempotencyKey?: string;
  requestHash: string;
  options: Prisma.InputJsonValue;
  placement: Placement;
  group?: { environmentId: string; mode: "sequential" | "parallel"; continueOnFailure: boolean };
  resolve(tx: Tx): Promise<{ environmentId: string; runs: RunSpec[] }>;
}

/**
 * The creation path inside a caller's transaction (stage 5 section 3: the scheduler records its fire and the
 * API its idempotency row in the same one). Unattended runs (schedule, bot) are server-only.
 */
export async function createRunsInTx(tx: Tx, input: CreateRunsInput, env: RunCreateEnv): Promise<CreatedRuns> {
  const { workspaceId, placement, subject } = input;
  const requestHash = placement.location === "desktop" ? hashRequest([input.requestHash, placement]) : input.requestHash;
  const requestedById = subject.kind === "user" ? subject.userId : null;
  const scheduleId = subject.kind === "schedule" ? subject.scheduleId : null;
  const botTokenId = subject.kind === "bot" ? subject.botTokenId : null;
  if (!requestedById && placement.location !== "server") throw new RunCreateError("invalid_request", "Unattended runs run on the server only");
  {
    await lockWorkspaceRuns(tx, workspaceId);
    if (requestedById) await revalidateRequester(tx, requestedById, workspaceId);

    if (input.idempotencyKey) {
      const existing = await tx.run.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: input.idempotencyKey } },
        select: { id: true, requestHash: true, groupRunId: true },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new RunCreateError("idempotency_conflict", "This Idempotency-Key was already used for a different request");
        if (!existing.groupRunId) return { runIds: [existing.id], groupRunId: null, created: false };
        const children = await tx.run.findMany({ where: { groupRunId: existing.groupRunId }, orderBy: { groupIndex: "asc" }, select: { id: true } });
        return { runIds: children.map((c) => c.id), groupRunId: existing.groupRunId, created: false };
      }
    }

    const { environmentId, runs } = await input.resolve(tx);
    await assertAuthSession(tx, environmentId, subject);
    await assertPersonalVariables(tx, environmentId, subject, runs);
    const desktopDeviceId = placement.location === "desktop" && requestedById ? await pickDevice(tx, requestedById, placement.deviceId, requiredCapabilities(runs, input.trigger, input.options, environmentId, tx)) : null;

    const queued = await tx.run.count({ where: { workspaceId, status: "queued" } });
    if (queued + runs.length > RUN_LIMITS.workspaceQueueLength) {
      throw new RunCreateError(
        "queue_full",
        runs.length > 1
          ? `This workspace has ${queued} runs waiting; the ${runs.length} runs of this group would pass the limit of ${RUN_LIMITS.workspaceQueueLength}. Nothing was queued.`
          : `This workspace already has ${queued} runs waiting. Try again when some have finished.`,
      );
    }
    if ((await env.freeBytes()) < env.minFreeBytes()) {
      throw new RunCreateError("storage_low", "The server is low on storage space, so new runs are paused. Ask an administrator.");
    }

    const group = input.group
      ? await tx.groupRun.create({
          data: { workspaceId, location: placement.location, desktopDeviceId, environmentId: input.group.environmentId, mode: input.group.mode, continueOnFailure: input.group.continueOnFailure, requestedById, scheduleId, botTokenId },
          select: { id: true },
        })
      : null;
    const runIds: string[] = [];
    for (const [index, spec] of runs.entries()) {
      const first = index === 0;
      const run = await tx.run.create({
        data: {
          workspaceId,
          scenarioId: spec.scenarioId,
          testOfScenarioId: spec.testOfScenarioId ?? null,
          environmentId,
          groupRunId: group?.id,
          groupIndex: group ? index : undefined,
          trigger: input.trigger,
          requestedById,
          scheduleId,
          botTokenId,
          idempotencyKey: first ? input.idempotencyKey : undefined,
          requestHash: first ? requestHash : undefined,
          location: placement.location,
          desktopDeviceId,
          snapshot: spec.snapshot,
          options: input.options,
        },
        select: { id: true },
      });
      runIds.push(run.id);
    }
    return { runIds, groupRunId: group?.id ?? null, created: true };
  }
}

/**
 * Saved scenarios of one environment's site, in the given order, as run specs (scheduler and API reuse it).
 * Another workspace's ids are 404, archived ones 409, another site's 400.
 */
export async function resolveScenarioRuns(tx: Tx, workspaceId: string, environmentId: string, scenarioIds: string[]): Promise<{ environmentId: string; runs: RunSpec[] }> {
  const environment = await findEnvironment(tx, workspaceId, environmentId);
  const scenarios = await findScenarios(tx, workspaceId, scenarioIds, environment.siteId);
  const runs: RunSpec[] = [];
  for (const scenario of scenarios) runs.push(await scenarioRun(tx, workspaceId, scenario, environment));
  return { environmentId: environment.id, runs };
}

export type EnvironmentRow = { id: string; name: string; baseUrl: string; siteId: string };
export type ScenarioRow = { id: string; name: string; steps: unknown; stepFormatVersion: number; retryOnFailure: boolean; maskingEnabled?: boolean };

export async function findEnvironment(tx: Tx, workspaceId: string, environmentId: string): Promise<EnvironmentRow> {
  const environment = await tx.environment.findFirst({ where: { id: environmentId, workspaceId } });
  if (!environment) throw RunCreateError.notFound();
  return environment;
}

/** In the requested order; another workspace's id is a 404, another site's a 400, an archived one a 409. */
export async function findScenarios(tx: Tx, workspaceId: string, ids: string[], siteId: string): Promise<ScenarioRow[]> {
  const rows = await tx.scenario.findMany({ where: { id: { in: ids }, workspaceId } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const scenario = byId.get(id);
    if (!scenario) throw RunCreateError.notFound();
    if (scenario.archivedAt) throw new RunCreateError("conflict", "Archived scenarios can't be run. Unarchive it first.");
    if (scenario.siteId !== siteId) throw new RunCreateError("invalid_request", "The environment belongs to another site than the scenario");
    return scenario;
  });
}

export async function scenarioRun(tx: Tx, workspaceId: string, scenario: ScenarioRow, environment: EnvironmentRow): Promise<RunSpec> {
  const steps = stepsSchema.parse(scenario.steps);
  return { scenarioId: scenario.id, snapshot: await buildSnapshot(tx, workspaceId, { id: scenario.id, name: scenario.name, steps, retryOnFailure: scenario.retryOnFailure, maskingEnabled: scenario.maskingEnabled ?? true }, environment) };
}

/**
 * Fixed at request time (contract section 2): steps, the whole-run retry setting (action spec 4.3; test runs
 * of unsaved steps use the default), environment, device, and variable keys only — never values.
 */
export async function buildSnapshot(
  tx: Tx,
  workspaceId: string,
  scenario: { id: string | null; name: string; steps: Step[]; retryOnFailure?: boolean; maskingEnabled?: boolean },
  environment: EnvironmentRow,
): Promise<RunSnapshot> {
  const variables = await tx.variable.findMany({ where: { environmentId: environment.id }, select: { key: true }, orderBy: { key: "asc" } });
  const attachments = await pinAttachments(tx, workspaceId, scenario.steps);
  // Stage 7 section 5: the site's selectors and the scenario switch, fixed now like the steps.
  const site = await tx.site.findUnique({ where: { id: environment.siteId }, select: { maskSelectors: true } });
  return runSnapshotSchema.parse({
    scenario: { id: scenario.id, name: scenario.name, stepFormatVersion: 1, steps: scenario.steps, retryOnFailure: scenario.retryOnFailure ?? true },
    environment: { id: environment.id, name: environment.name, baseUrl: environment.baseUrl },
    device: DEFAULT_DEVICE,
    variableKeys: variables.map((v) => v.key),
    attachments,
    masking: { enabled: scenario.maskingEnabled ?? true, selectors: splitSelectorList(site?.maskSelectors ?? ""), policyVersion: MASKING_POLICY_VERSION },
  });
}

/**
 * `attachment:<name>` tokens of uploadFile steps → the newest version of that name in this workspace, now.
 * The run uses that version even if a newer one is uploaded before it starts. A missing name is a 400.
 */
async function pinAttachments(tx: Tx, workspaceId: string, steps: Step[]): Promise<RunSnapshot["attachments"]> {
  const pinned: RunSnapshot["attachments"] = [];
  for (const { name, stepIndex } of uploadAttachmentRefs(steps)) {
    const row = await tx.attachment.findFirst({ where: { workspaceId, name }, orderBy: { version: "desc" }, select: { id: true, version: true } });
    if (!row) throw new RunCreateError("invalid_request", `Step ${stepIndex + 1}: no workspace attachment named "${name}". Upload it first.`);
    pinned.push({ name, id: row.id, version: row.version });
  }
  return pinned;
}

/** route() checked the requester before the lock; a change committed meanwhile (disabled, demoted, removed) must win. */
async function revalidateRequester(tx: Prisma.TransactionClient, actorId: string, workspaceId: string): Promise<void> {
  const user = await tx.user.findUnique({
    where: { id: actorId },
    select: { disabledAt: true, isInstanceAdmin: true, memberships: { where: { workspaceId }, select: { role: true } } },
  });
  if (!user || user.disabledAt) throw new RunCreateError("unauthenticated", "Sign in required");
  const role = user.memberships[0]?.role;
  const roles: Record<string, NonNullable<typeof role>> = role ? { [workspaceId]: role } : {};
  const decision = can({ userId: actorId, isInstanceAdmin: user.isInstanceAdmin, roles }, "run.create", { type: "run", workspaceId });
  if (decision === "not_found") throw RunCreateError.notFound();
  if (decision === "forbidden") throw new RunCreateError("forbidden", "Your role does not allow this");
}

export const DESKTOP_NOT_CONNECTED_MESSAGE = "Your desktop app is not connected. Open it and sign in, then try again.";
export const AUTH_SESSION_MISSING_MESSAGE = "This environment needs your own login session. Save one first.";

/** Capabilities the device must announce: every step action, plus the features the run uses (stage 7 section 7 included). */
export function runCapabilities(input: { steps: { action: string }[]; trigger: RunTrigger; video: boolean; useAuthSession: boolean; comparisonChild?: boolean }): string[] {
  const needed = new Set<string>(["stop-run", ...screenQualityCapabilities({ steps: input.steps, comparisonChild: input.comparisonChild === true })]);
  for (const step of input.steps) needed.add(step.action);
  if (input.video) needed.add("video");
  if (input.trigger === "test") needed.add("test-run");
  if (input.useAuthSession) needed.add("auth-session");
  return [...needed];
}

async function requiredCapabilities(runs: RunSpec[], trigger: RunTrigger, options: Prisma.InputJsonValue, environmentId: string, tx: Tx): Promise<string[]> {
  const environment = await tx.environment.findUnique({ where: { id: environmentId }, select: { useAuthSession: true } });
  return runCapabilities({
    steps: runs.flatMap((r) => r.snapshot.scenario.steps),
    trigger,
    video: (options as { video?: boolean }).video === true,
    useAuthSession: environment?.useAuthSession === true,
  });
}

/**
 * The requester's own online device: the one asked for, else the most recently seen. None → 409
 * desktop_not_connected; one that can't run every action or option → 409 app_update_required { missing }.
 */
async function pickDevice(tx: Tx, userId: string, deviceId: string | undefined, required: Promise<string[]>): Promise<string> {
  const onlineSince = new Date(Date.now() - DESKTOP_TIMINGS.onlineWindowMs);
  const device = await tx.desktopDevice.findFirst({
    where: { userId, connectionId: { not: null }, lastSeenAt: { gt: onlineSince }, ...(deviceId ? { id: deviceId } : {}) },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, capabilities: true },
  });
  if (!device) throw new RunCreateError("desktop_not_connected", DESKTOP_NOT_CONNECTED_MESSAGE);
  const missing = missingCapabilities(await required, device.capabilities);
  if (missing.length > 0) throw new RunCreateError("app_update_required", "Update the desktop app to run this.", { missing });
  return device.id;
}

export const RUN_VARIABLE_MISSING_MESSAGE = "This run uses personal variables you haven't set a value for. Add your value first.";

/**
 * Variables contract section 3: every personal variable the steps use needs the requester's own value — a
 * shared value with the same key or someone else's value never stands in. 409 variable_missing { keys }.
 */
async function assertPersonalVariables(tx: Tx, environmentId: string, subject: ValueSubject, runs: RunSpec[]): Promise<void> {
  const keys = new Set<string>();
  for (const run of runs) for (const key of await missingPersonalVariables(tx, { environmentId, subject, steps: run.snapshot.scenario.steps })) keys.add(key);
  if (keys.size > 0) throw new RunCreateError("variable_missing", RUN_VARIABLE_MISSING_MESSAGE, { keys: [...keys].sort() });
}

/** Contract section 5: an environment that needs a login session runs only with the requester's own, unexpired one. */
async function assertAuthSession(tx: Tx, environmentId: string, subject: ValueSubject): Promise<void> {
  const environment = await tx.environment.findUnique({ where: { id: environmentId }, select: { useAuthSession: true } });
  if (!environment?.useAuthSession) return;
  // The subject's own session only (person, schedule or bot token).
  if (!(await subjectAuthSession(tx, environmentId, subject))) throw new RunCreateError("auth_session_missing", AUTH_SESSION_MISSING_MESSAGE);
}
