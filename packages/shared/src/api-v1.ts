// The CI API `/api/v1` (stage 5 contract section 7): fixed shapes both the server and CI scripts rely on.
// Change them only through the contract; a breaking change needs /api/v2.
import { z } from "zod";
import { RUN_STATUSES } from "./run-status.js";

export const API_V1_PREFIX = "/api/v1";
/** Bot tokens look like `d2e_<random>`; lists show the first `BOT_TOKEN_PREFIX_LENGTH` characters. */
export const BOT_TOKEN_PREFIX = "d2e_";
export const BOT_TOKEN_PREFIX_LENGTH = 8;
export const BOT_TOKEN_SCOPES = ["runs:create", "runs:read", "runs:cancel"] as const;
export type BotTokenScope = (typeof BOT_TOKEN_SCOPES)[number];
export const BOT_TOKEN_TTL_DAYS = { default: 90, max: 365 } as const;

/** `Idempotency-Key` on `POST /api/v1/runs`: required, 1–128 characters, per token, kept 24 hours. */
export const IDEMPOTENCY = {
  header: "Idempotency-Key",
  minLength: 1,
  maxLength: 128,
  ttlMs: 24 * 60 * 60 * 1000,
} as const;
export const idempotencyKeySchema = z.string().min(IDEMPOTENCY.minLength).max(IDEMPOTENCY.maxLength);

/** `GET /api/v1/runs/{id}?wait=<seconds>`: at most 60; concurrent waits per token / per web process. */
export const API_V1_WAIT = { maxSeconds: 60, pollMs: 1_000, perToken: 5, total: 100 } as const;

/** Run options a CI request may set (the subset of `runOptionsSchema` that fits CI); part of the idempotency hash. */
export const apiV1RunOptionsSchema = z.strictObject({
  /** A `passed` run with warnings counts as a CI failure (`apiV1Passed`). The stored status is unchanged. */
  failOnWarning: z.boolean().optional(),
  video: z.boolean().optional(),
});
export type ApiV1RunOptions = z.infer<typeof apiV1RunOptionsSchema>;

const groupOptions = {
  mode: z.enum(["sequential", "parallel"]).optional(),
  continueOnFailure: z.boolean().optional(),
};
const runOptions = { options: apiV1RunOptionsSchema.optional() };

/** Three request shapes: one scenario, listed scenarios (a group), or every unarchived scenario of a tag (a group). */
export const apiV1CreateRunSchema = z.union([
  z.strictObject({ environmentId: z.string().min(1), scenarioId: z.string().min(1), ...runOptions, location: z.literal("server").optional() }),
  z.strictObject({ environmentId: z.string().min(1), scenarioIds: z.array(z.string().min(1)).min(1).max(100), ...groupOptions, ...runOptions, location: z.literal("server").optional() }),
  z.strictObject({ environmentId: z.string().min(1), tag: z.string().min(1), ...groupOptions, ...runOptions, location: z.literal("server").optional() }),
]);
export type ApiV1CreateRun = z.infer<typeof apiV1CreateRunSchema>;

export const apiV1RunChildSchema = z.strictObject({
  id: z.string(),
  scenarioId: z.string().nullable(),
  status: z.enum(RUN_STATUSES),
  url: z.string().nullable(),
});

/** Response of create, read and cancel. `kind: group` has `children`. CI passes only on `passed`. */
export const apiV1RunSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["run", "group"]),
  status: z.enum(RUN_STATUSES),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  warningCount: z.number().int().min(0),
  /** The request's `options.failOnWarning`: warnings then fail CI. */
  failOnWarning: z.boolean(),
  /** The CI verdict (`apiV1Passed`); false until finished. */
  passed: z.boolean(),
  /** Result page; null when the server has no PUBLIC_URL. */
  url: z.string().nullable(),
  children: z.array(apiV1RunChildSchema).optional(),
});
export type ApiV1Run = z.infer<typeof apiV1RunSchema>;

export const API_V1_ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_request",
  "idempotency_conflict",
  "conflict", // the request clashes with the current state (e.g. an archived scenario)
  "variable_missing",
  "auth_session_missing",
  "queue_full",
  "storage_low",
  "too_many_waits",
  "internal",
] as const;
export type ApiV1ErrorCode = (typeof API_V1_ERROR_CODES)[number];
export const apiV1ErrorSchema = z.strictObject({
  error: z.object({ code: z.enum(API_V1_ERROR_CODES), message: z.string(), keys: z.array(z.string()).optional() }),
});
export type ApiV1Error = z.infer<typeof apiV1ErrorSchema>;

/** CI passes only on `passed`, and with `failOnWarning` only without warnings. */
export function apiV1Passed(run: Pick<ApiV1Run, "status" | "warningCount" | "failOnWarning">): boolean {
  return run.status === "passed" && !(run.failOnWarning && run.warningCount > 0);
}
