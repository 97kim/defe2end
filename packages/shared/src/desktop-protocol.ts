// Stage 4 contract sections 3 and 4: what the server and the desktop app say to each other. Both sides parse
// every message with these schemas, so change them only through the contract (and bump the protocol version
// when an old app could misread the new shape).
import { z } from "zod";
import { executionPlanSchema, stepOutcomeSchema, storageStateSchema } from "./execution.js";
import { COMPARISON_SIDES, maskingSettingsSchema, renderConditionsSchema, VISUAL_RUNTIMES } from "./screen-quality.js";
import { RUN_TERMINAL_STATUSES, RUN_STATUSES, stopCauseSchema } from "./run-status.js";
import { STEP_ACTIONS } from "./steps.js";
import { VERSIONS } from "./version.js";

export const DESKTOP_PROTOCOL_VERSION = 1;
/**
 * App–server rule (stage 8 contract section 1, plan section 6 "server N takes app N-1", N = minor): same major
 * version, and the app's minor at least the server's minor − 1. Pre-release tags of the server don't matter.
 * The protocol version and capability checks still decide what the app can actually run.
 */
export function oldestSupportedApp(server: string): string {
  const m = /^(\d+)\.(\d+)\.\d+/.exec(server);
  if (!m) return "0.0.0";
  return `${Number(m[1])}.${Math.max(Number(m[2]) - 1, 0)}.0`;
}

/**
 * Whether a server of version `server` takes this app: at least `minimum` and the same major version. An
 * unreleased build (`0.0.0`, nothing stamped) only checks the minimum.
 */
export function appVersionSupported(app: string, server: string, minimum = oldestSupportedApp(server)): boolean {
  if (compareVersions(app, minimum) < 0) return false;
  if (server === "0.0.0") return true;
  const major = (v: string) => /^(\d+)\./.exec(v)?.[1];
  return major(app) !== undefined && major(app) === major(server);
}

/** Oldest app the server accepts when `DESKTOP_MIN_VERSION` is unset. */
export const DESKTOP_MIN_VERSION_DEFAULT = oldestSupportedApp(VERSIONS.server);

/** Timings (contract sections 3.2 and 4.2). */
export const DESKTOP_TIMINGS = {
  sseHeartbeatMs: 30_000,
  /** The app reconnects after this long without any message. */
  sseIdleMs: 75_000,
  sseRetryMs: 5_000,
  sseRetryJitterMs: 2_000,
  /** `DesktopDevice.lastSeenAt` refresh; online = seen within `onlineWindowMs`. */
  lastSeenRefreshMs: 15_000,
  onlineWindowMs: 45_000,
  dispatchPollMs: 1_000,
  runHeartbeatMs: 15_000,
  runLeaseMs: 90_000,
  /** The app stops a run this long before its last known lease ends if it couldn't renew it. */
  leaseSafetyMs: 10_000,
} as const;

/** The app runs at most this many children of a group at once, whatever `concurrency` says. */
export const DESKTOP_MAX_CONCURRENCY = 4;
export const DESKTOP_LABEL_MAX = 40;

export const DESKTOP_HEADERS = {
  client: "Defe2end-Client",
  capabilities: "Defe2end-Capabilities",
  activeRuns: "Defe2end-Active-Runs",
  /** Artifact PUTs carry the run's claim token here; the JSON endpoints carry it in the body. */
  claimToken: "Defe2end-Claim-Token",
} as const;

const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

export interface DesktopClientHeader {
  app: string;
  runner: string;
  protocol: number;
}

/** Parses `Defe2end-Client: app=<semver>; runner=<semver>; protocol=1`. Null when malformed or incomplete. */
export function parseDesktopClientHeader(value: string | null | undefined): DesktopClientHeader | null {
  if (!value) return null;
  const fields = new Map<string, string>();
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const key = part.slice(0, eq).trim();
    if (fields.has(key)) return null;
    fields.set(key, part.slice(eq + 1).trim());
  }
  const app = fields.get("app");
  const runner = fields.get("runner");
  const protocol = fields.get("protocol");
  if (!app || !runner || !protocol || !semver.safeParse(app).success || !semver.safeParse(runner).success || !/^\d+$/.test(protocol)) return null;
  return { app, runner, protocol: Number(protocol) };
}

export function formatDesktopClientHeader(h: DesktopClientHeader): string {
  return `app=${h.app}; runner=${h.runner}; protocol=${h.protocol}`;
}

/** Comma list headers (`Defe2end-Capabilities`, `Defe2end-Active-Runs`); blanks dropped. */
export function parseCommaList(value: string | null | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** SemVer precedence: `+build` is ignored, and a pre-release sorts before its release (`1.2.0-beta.1 < 1.2.0`). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const core = v.split("+")[0]!;
    const dash = core.indexOf("-");
    return { nums: (dash < 0 ? core : core.slice(0, dash)).split(".").map(Number), pre: dash < 0 ? [] : core.slice(dash + 1).split(".") };
  };
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return Math.sign(pb.pre.length - pa.pre.length);
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Feature flags an app announces besides the action names it can run. */
export const DESKTOP_FEATURES = [
  "stop-run",
  "auth-session",
  "video",
  "test-run",
  "auth-session-target",
  /** Stage 7 contract section 7: masking script, cover before capture, refuse to capture unmasked. */
  "masking-v1",
  /** Baseline download and visual verdict reports. */
  "visual-compare-v1",
  /** Accessibility snapshot capture and hiding for environment comparison. */
  "a11y-snapshot-v1",
] as const;

/** Owner of a captured login session: the token's user, a schedule or a bot token (stage 5 section 1.1). */
export const authSessionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({ kind: z.literal("schedule"), scheduleId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("bot"), botTokenId: z.string().min(1) }),
]);
export type AuthSessionTarget = z.infer<typeof authSessionTargetSchema>;
export type DesktopFeature = (typeof DESKTOP_FEATURES)[number];
/** Everything this build can do: every step action plus every feature flag. */
export const DESKTOP_CAPABILITIES: readonly string[] = [...STEP_ACTIONS, ...DESKTOP_FEATURES];

/** Capabilities a run needs that the device lacks (409 `app_update_required { missing }` when non-empty). */
export function missingCapabilities(required: Iterable<string>, available: Iterable<string>): string[] {
  const have = new Set(available);
  return [...new Set(required)].filter((c) => !have.has(c));
}

export const DESKTOP_ERROR_CODES = [
  "app_update_required",
  "desktop_not_connected",
  "auth_session_missing",
  "lease_lost",
  "run_finalized",
  "verdict_mismatch",
  "permission_lost",
  "desktop_lost",
  "desktop_reconnected",
] as const;
export type DesktopErrorCode = (typeof DESKTOP_ERROR_CODES)[number];

/** Error body of the desktop APIs; specific codes extend it below. */
export const desktopErrorSchema = z.object({ code: z.enum(DESKTOP_ERROR_CODES), message: z.string().optional() });
export type DesktopError = z.infer<typeof desktopErrorSchema>;

/** 426 on the stream: the app is older than the minimum, or speaks another protocol. */
export const appUpdateRequiredSchema = z.strictObject({
  code: z.literal("app_update_required"),
  minimum: z.string(),
  downloadUrl: z.string().optional(),
});
export type AppUpdateRequired = z.infer<typeof appUpdateRequiredSchema>;

/** 409 at run creation: the target device can't run some action or option of this run. */
export const capabilitiesMissingSchema = z.strictObject({
  code: z.literal("app_update_required"),
  missing: z.array(z.string()).min(1),
});
export type CapabilitiesMissing = z.infer<typeof capabilitiesMissingSchema>;

/** 409 when a completion arrives for a run that already ended. The app treats it as final. */
export const runFinalizedSchema = z.strictObject({ code: z.literal("run_finalized"), status: z.enum(RUN_TERMINAL_STATUSES) });

// --- Token exchange (POST /api/desktop/token) -------------------------------------

export const desktopTokenRequestSchema = z.strictObject({
  installId: z.uuid(),
  label: z.string().trim().min(1).max(DESKTOP_LABEL_MAX),
});
export type DesktopTokenRequest = z.infer<typeof desktopTokenRequestSchema>;

export const desktopTokenResponseSchema = z.strictObject({
  token: z.string().min(1),
  userId: z.string(),
  deviceId: z.string(),
  expiresAt: z.iso.datetime(),
});
export type DesktopTokenResponse = z.infer<typeof desktopTokenResponseSchema>;

// --- Run message -------------------------------------------------------------------

/** Decided by the server; the app follows it (contract section 4.3, action spec 4.3). */
export const desktopRunPolicySchema = z.strictObject({
  /**
   * Total whole-run attempts, like `RUN_RETRY_ATTEMPTS` (`maxAttempts` of `shouldRetryRun`). The server
   * already folded the scenario's `retryOnFailure` in: 1 = never retry.
   */
  retryAttempts: z.number().int().min(1),
  runTimeoutMs: z.number().int().positive(),
  video: z.boolean(),
  traceOnFailure: z.boolean(),
});
export type DesktopRunPolicy = z.infer<typeof desktopRunPolicySchema>;

/** Files of the snapshot, fetched from `GET /api/desktop/runs/{id}/attachments/{attachmentId}`. */
export const desktopAttachmentSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  version: z.number().int().min(1),
  contentType: z.string(),
  sizeBytes: z.number().int().min(0),
});
export type DesktopAttachment = z.infer<typeof desktopAttachmentSchema>;

/**
 * A baseline version the run is pinned to (stage 7 contract section 4). The app fetches the image from
 * `GET /api/desktop/runs/{runId}/baselines/{versionId}` and judges every screenshot of that key against it.
 */
export const desktopPinnedBaselineSchema = z.strictObject({
  versionId: z.string().min(1),
  stepId: z.string().min(1),
  environmentId: z.string().min(1),
  /** Normalized device key (device name and viewport). */
  device: z.string().min(1),
  runtime: z.enum(VISUAL_RUNTIMES),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  render: renderConditionsSchema,
});
export type DesktopPinnedBaseline = z.infer<typeof desktopPinnedBaselineSchema>;

/** Masking settings of the run (stage 7 contract section 5); step `mask` stays on the steps. */
export const desktopMaskingSchema = maskingSettingsSchema;
export type DesktopMasking = z.infer<typeof desktopMaskingSchema>;

/** Kept in memory only by the app: `plan.variables` and `plan.storageState` hold secrets. */
export const desktopRunMessageSchema = z.strictObject({
  type: z.literal("run"),
  runId: z.string(),
  workspaceId: z.string(),
  groupRunId: z.string().nullable(),
  groupIndex: z.number().int().min(0).nullable(),
  trigger: z.enum(["manual", "test", "schedule", "api"]),
  plan: executionPlanSchema,
  policy: desktopRunPolicySchema,
  attachments: z.array(desktopAttachmentSchema),
  /** Children of this group the app may run at once (capped at `DESKTOP_MAX_CONCURRENCY`). */
  concurrency: z.number().int().min(1),
  /** Stage 7: baseline versions pinned when the run was created or assigned. Absent = none. */
  baselines: z.array(desktopPinnedBaselineSchema).optional(),
  masking: desktopMaskingSchema.optional(),
  /** Set on an environment comparison child: no visual regression, accessibility snapshot per screenshot. */
  comparison: z.strictObject({ comparisonId: z.string().min(1), side: z.enum(COMPARISON_SIDES) }).optional(),
});
export type DesktopRunMessage = z.infer<typeof desktopRunMessageSchema>;

// --- SSE messages (GET /api/desktop/stream) ----------------------------------------

export const desktopStreamMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("connected"),
    connectionId: z.string(),
    minimum: z.string(),
    serverVersion: z.string(),
    recorder: z.strictObject({ testAttributes: z.array(z.string()) }),
  }),
  desktopRunMessageSchema,
  z.strictObject({
    type: z.literal("capture-auth-state"),
    /** Echoed back on registration so the web UI can match it. */
    requestId: z.string(),
    /**
     * Whose session to save (stage 5 section 1.1). Sent only to apps announcing `auth-session-target`; absent
     * means the token's user. The app returns it unchanged on registration.
     */
    target: authSessionTargetSchema.optional(),
    workspaceId: z.string(),
    environmentId: z.string(),
    /** Page opened in the visible browser (the environment's base URL). */
    url: z.string(),
  }),
  z.strictObject({ type: z.literal("stop-run"), runId: z.string() }),
  z.strictObject({ type: z.literal("heartbeat") }),
]);
export type DesktopStreamMessage = z.infer<typeof desktopStreamMessageSchema>;

// --- Run lifecycle (/api/desktop/runs/{id}/…) ---------------------------------------

/** `POST …/start`. A run that already ended comes back with its status and no claim token: the app drops it. */
export const desktopStartResponseSchema = z.strictObject({
  status: z.enum(RUN_STATUSES),
  claimToken: z.string().optional(),
  leaseExpiresAt: z.iso.datetime().optional(),
  /**
   * Lease left when the server answered, in ms, with a claim token. The app counts it down on its own
   * monotonic clock from when it sent the request, never against `leaseExpiresAt` (clocks differ). A repeated
   * start renews the lease like a heartbeat.
   */
  leaseRemainingMs: z.number().int().min(0).optional(),
});
export type DesktopStartResponse = z.infer<typeof desktopStartResponseSchema>;

export const desktopHeartbeatRequestSchema = z.strictObject({ claimToken: z.string() });

/** `POST …/heartbeat`. The app stops on its own `leaseSafetyMs` before `leaseExpiresAt` if it can't renew. */
export const desktopHeartbeatResponseSchema = z.strictObject({
  leaseExpiresAt: z.iso.datetime(),
  /** Lease left when the server answered, in ms; see the start response. */
  leaseRemainingMs: z.number().int().min(0),
  cancelRequested: z.boolean(),
});
export type DesktopHeartbeatResponse = z.infer<typeof desktopHeartbeatResponseSchema>;

/** `POST …/steps`: live progress, best effort, idempotent by (attempt, index). */
export const desktopStepEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("stepStarted"), attempt: z.number().int().min(1), index: z.number().int().min(0), stepId: z.string(), action: z.string(), startedAt: z.iso.datetime() }),
  z.strictObject({ type: z.literal("stepFinished"), result: stepOutcomeSchema }),
]);
export const desktopStepsRequestSchema = z.strictObject({ claimToken: z.string(), events: z.array(desktopStepEventSchema).min(1) });

/** `POST …/complete`. `steps` holds every attempt's results (masked); the server overwrites by (attempt, index). */
export const desktopCompleteRequestSchema = z.strictObject({
  claimToken: z.string(),
  verdict: z.enum(RUN_TERMINAL_STATUSES),
  stopCause: stopCauseSchema,
  attemptCount: z.number().int().min(1),
  passedAfterRetry: z.boolean(),
  durationMs: z.number().int().min(0),
  steps: z.array(stepOutcomeSchema),
});
export type DesktopCompleteRequest = z.infer<typeof desktopCompleteRequestSchema>;

// --- Login sessions (POST /api/desktop/auth-sessions, contract section 5) --------------

/** `POST /api/desktop/auth-sessions` body. The owner is the token's user, never a body field. `requestId` echoes a `capture-auth-state` so the web UI can match it. */
export const authSessionRegisterSchema = z.strictObject({
  workspaceId: z.string().min(1),
  environmentId: z.string().min(1),
  requestId: z.string().min(1).max(100).optional(),
  /** The capture request's target, unchanged; absent = the token's user. The server re-checks the right to it. */
  target: authSessionTargetSchema.optional(),
  storageState: storageStateSchema,
});
export type AuthSessionRegister = z.infer<typeof authSessionRegisterSchema>;
