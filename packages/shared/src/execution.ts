// Stage 3 contract section 5: what goes into the runner and what comes out of it. The worker and the
// desktop app (stage 4) both drive `@defe2end/runner` through these shapes, so change them only through
// the contract.
import { z } from "zod";
import { NO_STOP, RUN_ERROR_CODES, RUN_TERMINAL_STATUSES, STEP_RESULT_STATUSES, type StopCause } from "./run-status.js";
import { stepSchema, STEP_FORMAT_VERSION } from "./steps.js";

/** Resource limits (contract section 3). Defaults are estimates until measured; deployments override them by env. */
export const RUN_LIMITS = {
  maxConcurrentRuns: 4,
  workerConcurrency: 2,
  workspaceConcurrency: 4,
  workspaceQueueLength: 100,
  stepTimeoutMs: 30_000,
  runTimeoutMs: 15 * 60 * 1000,
  minFreeDiskMb: 1024,
  runArtifactBytes: 200 * 1024 * 1024,
  leaseMs: 30_000,
  heartbeatMs: 10_000,
} as const;

export const RUN_TRIGGERS = ["manual", "test", "schedule", "api"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** Why a step did not pass. Messages that go with them are masked before they leave the runner. */
export const STEP_ERROR_CODES = [
  "assertion_failed",
  "timeout",
  /** `assertVisibleOrWarn` target missing (status `warning`). */
  "warning",
  /** A popup action ran with no current new window. */
  "no_popup",
  "dialog_failed",
  /** `uploadFile` could not fetch a file (status, redirect or size limit). */
  "download_failed",
  "missing_secret",
  "navigation_failed",
  "blocked_request",
  "invalid_step",
  "unsupported_action",
  /** Infrastructure trouble inside the step (browser gone, protocol error); the step is `error`. */
  "infra",
  "cancelled",
  "timed_out",
] as const;
export type StepErrorCode = (typeof STEP_ERROR_CODES)[number];

/** `dom_summary`: masked page structure at a failed step (stage 6 contract section 8), for AI diagnosis. */
export const ARTIFACT_KINDS = ["screenshot", "video", "trace", "log", "dom_summary"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** The only content type each kind is stored and served with (contract section 7). */
export const ARTIFACT_CONTENT_TYPES: Record<ArtifactKind, string> = {
  screenshot: "image/png",
  video: "video/webm",
  trace: "application/zip",
  log: "text/plain; charset=utf-8",
  dom_summary: "text/plain; charset=utf-8",
};

/** Upper bound of one `dom_summary` artifact (stage 6 contract section 8). */
export const DOM_SUMMARY_MAX_BYTES = 8 * 1024;
/**
 * Upper bound of one step's browser log (`log` artifact with a step index). The runner keeps at most 50 lines of
 * 500 characters per step, which stays under this in UTF-8.
 */
export const STEP_LOG_MAX_BYTES = 96 * 1024;

export const deviceSchema = z.strictObject({
  viewport: z.strictObject({ width: z.number().int().min(200).max(4000), height: z.number().int().min(200).max(4000) }),
  locale: z.string().max(35).optional(),
  timezoneId: z.string().max(64).optional(),
  userAgent: z.string().max(500).optional(),
});
export type Device = z.infer<typeof deviceSchema>;

export const DEFAULT_DEVICE: Device = { viewport: { width: 1280, height: 720 } };

/**
 * A target-site login session in Playwright's storage state format (stage 4 contract section 5). It is a
 * credential: like the plan that carries it, never stored, logged or put in an event.
 */
export const storageStateSchema = z.strictObject({
  cookies: z.array(
    z.strictObject({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      /** Unix seconds; -1 for a session cookie. */
      expires: z.number(),
      httpOnly: z.boolean(),
      secure: z.boolean(),
      sameSite: z.enum(["Strict", "Lax", "None"]),
    }),
  ),
  origins: z.array(z.strictObject({ origin: z.string(), localStorage: z.array(z.strictObject({ name: z.string(), value: z.string() })) })),
});
export type StorageState = z.infer<typeof storageStateSchema>;

/**
 * Fixed when the run is requested (contract section 2): what the result screen shows even after the
 * scenario changes. Variable **keys only** — values are read by the worker when the run starts.
 */
export const runSnapshotSchema = z.strictObject({
  scenario: z.strictObject({
    id: z.string().nullable(),
    name: z.string(),
    stepFormatVersion: z.literal(STEP_FORMAT_VERSION),
    steps: z.array(stepSchema),
    /** Scenario setting fixed at request time: rerun the whole scenario once after a `failed` attempt (spec 4.3). */
    retryOnFailure: z.boolean().default(true),
  }),
  environment: z.strictObject({ id: z.string(), name: z.string(), baseUrl: z.string() }),
  device: deviceSchema,
  variableKeys: z.array(z.string()),
  /** Workspace attachments the uploadFile steps refer to (`attachment:<name>`), pinned to the version current at request time. */
  attachments: z.array(z.strictObject({ name: z.string(), id: z.string(), version: z.number().int().positive() })).default([]),
});
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

/** Per-run options chosen in the request (`Run.options`). The worker copies `video` into `capture.video`. */
export const runOptionsSchema = z.strictObject({
  /** Off unless the request turns it on: video can't hide secrets or personal data (contract section 6). */
  video: z.boolean().optional(),
  /** CI only: a `passed` run with warnings counts as a failure in the CI report. The stored verdict is unchanged. */
  failOnWarning: z.boolean().optional(),
});
export type RunOptions = z.infer<typeof runOptionsSchema>;

/**
 * Runner input. Built in memory right before the run and **never stored or logged**: `variables` holds secret
 * values in plain text, `storageState` a login session. The runner substitutes `{{KEY}}` once per step (`substituteVariables`); an unknown key
 * stays literal and an empty secret fails only that step, and masks every secret value in what it emits.
 */
export const executionPlanSchema = z.strictObject({
  /** Also marks the run's browser process (sweep after a crash), so it is an id, never free text. */
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** Whole-run attempt number (spec 4.3), 1-based; copied into every step result. Default 1. */
  attempt: z.number().int().min(1).optional(),
  baseUrl: z.string(),
  steps: z.array(stepSchema),
  variables: z.record(z.string(), z.strictObject({ value: z.string(), secret: z.boolean() })),
  device: deviceSchema,
  /** Default per-step timeout; a step's `timeout` overrides it (spec default 30000, `wait` 1000). The whole-run timeout is the caller's abort signal. */
  stepTimeoutMs: z.number().int().positive(),
  network: z.strictObject({
    /** Cloud metadata addresses are always blocked; this adds private ranges (contract section 5). */
    blockPrivateNetworks: z.boolean(),
  }),
  /** What to record besides screenshots (contract section 6). */
  capture: z.strictObject({
    /** Only when the request turned it on explicitly: video can't hide secrets. */
    video: z.boolean(),
    /** Trace of a failed run; the runner never records one when a step references a secret variable. */
    traceOnFailure: z.boolean(),
  }),
  /** Login session put into every attempt's new browser context. Memory only, like `variables`. */
  storageState: storageStateSchema.optional(),
});
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

/** One finished step, as stored in `StepResult`. Every text field is already masked. */
export const stepOutcomeSchema = z.strictObject({
  index: z.number().int().min(0),
  stepId: z.string(),
  action: z.string(),
  /** Display name (`name` or `Step {n}: {action}`). */
  name: z.string().optional(),
  status: z.enum(STEP_RESULT_STATUSES),
  /** Whole-run attempt this result belongs to (spec 4.3), 1-based. */
  attempt: z.number().int().min(1),
  /** Tries of this step within the attempt (at most 2, spec 2.9); 0 for steps that never ran. */
  attempts: z.number().int().min(0),
  /** The step failed once and was run again ("retried"). */
  retried: z.boolean().optional(),
  /** A page-changing action (click, fill…) ran more than once: the target may have received it twice. */
  possibleDuplicate: z.boolean().optional(),
  startedAt: z.iso.datetime(),
  durationMs: z.number().int().min(0),
  errorCode: z.enum(STEP_ERROR_CODES).optional(),
  /** Failure reason, warning text (`warning`) or "[optional] reason" (`skipped`). */
  errorMessage: z.string().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
});
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

/** What an `ArtifactSink` returns once a file is stored and registered. */
export const artifactRefSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(ARTIFACT_KINDS),
  stepIndex: z.number().int().min(0).optional(),
  /** Whole-run attempt the file belongs to (spec 4.3). */
  attempt: z.number().int().min(1).optional(),
  /** Display name only, never a file path. */
  name: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().min(0),
});
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

/** Runner output stream, in order. Text is masked before it is emitted. */
export const runnerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("stepStarted"), index: z.number().int(), stepId: z.string(), action: z.string(), startedAt: z.iso.datetime() }),
  z.strictObject({ type: z.literal("stepFinished"), result: stepOutcomeSchema }),
  z.strictObject({ type: z.literal("artifact"), artifact: artifactRefSchema }),
  z.strictObject({
    type: z.literal("log"),
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
    stepIndex: z.number().int().optional(),
  }),
]);
export type RunnerEvent = z.infer<typeof runnerEventSchema>;

/** The runner's final answer. The caller stores it only if it still owns the run (contract section 4.1). */
export const runVerdictSchema = z.strictObject({
  status: z.enum(RUN_TERMINAL_STATUSES),
  errorCode: z.enum(RUN_ERROR_CODES).optional(),
  /** Masked. */
  errorMessage: z.string().optional(),
  browserVersion: z.string().optional(),
  /** Steps that ended `warning` in this attempt (spec 4.2). */
  warningCount: z.number().int().min(0),
});
export type RunVerdict = z.infer<typeof runVerdictSchema>;

/** The stop cause a verdict carries (what the desktop app reports with it, stage 4 contract section 4.3). */
export function stopCauseOf(verdict: RunVerdict): StopCause {
  if (verdict.status === "cancelled" || verdict.status === "timed_out") return { type: verdict.status };
  return verdict.status === "error" && verdict.errorCode ? { type: "infra", code: verdict.errorCode } : NO_STOP;
}

export interface ArtifactMeta {
  kind: ArtifactKind;
  stepIndex?: number;
  attempt?: number;
  /** Display name; the storage key is chosen by the sink, never from this. */
  name: string;
}

/** Stream one file: `write` chunks, then exactly one of `complete` or `abort`. */
export interface ArtifactWriter {
  write(chunk: Uint8Array): Promise<void>;
  complete(): Promise<ArtifactRef>;
  /** Drops the partial file (failure or cancellation). */
  abort(reason: string): Promise<void>;
}

/**
 * Where the runner puts files. The worker stores them (temp write → atomic move → ownership-checked
 * registration); the desktop app uploads them. A sink rejects with `ArtifactLimitError` once the run's
 * total is over its limit, which ends the run as `error(artifact_limit)`.
 */
export interface ArtifactSink {
  open(meta: ArtifactMeta): Promise<ArtifactWriter>;
}

export class ArtifactLimitError extends Error {
  readonly code = "artifact_limit" as const;
  constructor(limitBytes: number) {
    super(`Artifacts of this run exceed ${Math.round(limitBytes / 1024 / 1024)} MB`);
  }
}
