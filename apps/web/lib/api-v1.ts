// The CI API `/api/v1` (stage 5 contract section 7): bot token authentication, run creation with a per-token
// `Idempotency-Key`, bounded waiting and cancel. Shapes come from `@defe2end/shared` api-v1.ts.
import { createHash, randomBytes } from "node:crypto";
import { deleteExpiredApiIdempotency as deleteExpiredKeys, lockWorkspaceRuns, requestCancel, type Prisma } from "@defe2end/db";
import { API_V1_WAIT, apiV1Passed, BOT_TOKEN_PREFIX, BOT_TOKEN_PREFIX_LENGTH, IDEMPOTENCY, idempotencyKeySchema, type ApiV1CreateRun, type ApiV1RunOptions, type ApiV1ErrorCode, type ApiV1Run, type BotTokenScope, type RunStatus } from "@defe2end/shared";
import { ZodError } from "zod";
import { ApiError, errorResponse } from "./api";
import { getDb } from "./db";
import { createRunsInTx, resolveScenarioRuns } from "./run-create";

type Tx = Prisma.TransactionClient;

const STATUS: Record<ApiV1ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  idempotency_conflict: 409,
  conflict: 409,
  variable_missing: 409,
  auth_session_missing: 409,
  queue_full: 429,
  storage_low: 503,
  too_many_waits: 429,
  internal: 500,
};

export class ApiV1Error extends Error {
  constructor(
    readonly code: ApiV1ErrorCode,
    message: string,
    readonly status = STATUS[code],
  ) {
    super(message);
  }
}

function v1Error(code: ApiV1ErrorCode, message: string, status = STATUS[code], keys?: string[]): Response {
  return Response.json({ error: { code, message, ...(keys ? { keys } : {}) } }, { status });
}

/** Shared services throw the web `ApiError`; codes outside the fixed v1 list keep their status as `invalid_request`. */
async function toV1Response(err: unknown): Promise<Response> {
  if (err instanceof ApiV1Error) return v1Error(err.code, err.message, err.status);
  if (err instanceof ZodError) return v1Error("invalid_request", err.issues.map((i) => i.message).join("; "));
  if (err instanceof ApiError) {
    const res = errorResponse(err.code, err.message);
    const known = (STATUS as Record<string, number>)[err.code] !== undefined;
    const keys = Array.isArray(err.details?.keys) ? (err.details.keys as string[]) : Array.isArray(err.details?.missing) ? (err.details.missing as string[]) : undefined;
    return v1Error(known ? (err.code as ApiV1ErrorCode) : "invalid_request", err.message, res.status, keys);
  }
  console.error("API v1 route failed", err);
  return v1Error("internal", "Internal error");
}

// --- Tokens ---------------------------------------------------------------------------

export function hashBotToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** A new `d2e_<random>` token: the raw value (shown once), its hash and its list prefix. */
export function generateBotToken(): { raw: string; tokenHash: string; prefix: string } {
  const raw = `${BOT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, tokenHash: hashBotToken(raw), prefix: raw.slice(0, BOT_TOKEN_PREFIX_LENGTH) };
}

export interface BotPrincipal {
  botTokenId: string;
  workspaceId: string;
  workspaceSlug: string;
  scopes: string[];
}

const LAST_USED_EVERY_MS = 60_000;

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

/** Valid = known hash, not revoked, not expired. `touch` updates `lastUsedAt` at most once a minute. */
export async function verifyBotToken(raw: string | null, touch = true): Promise<BotPrincipal | null> {
  if (!raw || !raw.startsWith(BOT_TOKEN_PREFIX)) return null;
  const tokenHash = hashBotToken(raw);
  const row = await getDb().botToken.findUnique({ where: { tokenHash }, select: { id: true, workspaceId: true, scopes: true, expiresAt: true, revokedAt: true, workspace: { select: { slug: true } } } });
  if (!row || row.revokedAt || row.expiresAt <= new Date()) return null;
  if (touch) {
    const now = new Date();
    await getDb().botToken.updateMany({
      where: { id: row.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_EVERY_MS) } }] },
      data: { lastUsedAt: now },
    });
  }
  return { botTokenId: row.id, workspaceId: row.workspaceId, workspaceSlug: row.workspace.slug, scopes: row.scopes };
}

type V1Handler<P> = (ctx: { request: Request; params: P; bot: BotPrincipal }) => Promise<Response>;

/** Wraps a `/api/v1` handler: 401 without a valid token, 403 without the scope, errors in the v1 shape. */
export function botRoute<P extends Record<string, string>>(scope: BotTokenScope, handler: V1Handler<P>) {
  const wrapped = async (request: Request, context: { params: Promise<P> }) => {
    try {
      // MCP tokens open `/api/mcp/*` only (stage 6 contract section 3).
      if (bearer(request)?.startsWith("mcp_")) return v1Error("forbidden", "MCP tokens work on /api/mcp only");
      const bot = await verifyBotToken(bearer(request));
      if (!bot) return v1Error("unauthenticated", "A valid bot token is required");
      if (!bot.scopes.includes(scope)) return v1Error("forbidden", `This token lacks the ${scope} scope`);
      return await handler({ request, params: await context.params, bot });
    } catch (err) {
      return toV1Response(err);
    }
  };
  return Object.assign(wrapped, { botAuth: true as const, botScope: scope });
}

// --- Responses ------------------------------------------------------------------------

function publicBase(): string | null {
  return process.env.PUBLIC_URL?.replace(/\/+$/, "") || null;
}

const runUrl = (slug: string, runId: string) => {
  const base = publicBase();
  return base ? `${base}/w/${slug}/runs/${runId}` : null;
};
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** A run or a group of this workspace in the v1 shape; null if neither exists here. */
export async function readApiRun(db: Tx | ReturnType<typeof getDb>, bot: Pick<BotPrincipal, "workspaceId" | "workspaceSlug">, id: string): Promise<ApiV1Run | null> {
  const run = await db.run.findFirst({ where: { id, workspaceId: bot.workspaceId, trigger: { not: "test" } }, select: { id: true, status: true, startedAt: true, finishedAt: true, warningCount: true, options: true } });
  if (run) return withVerdict({ id: run.id, kind: "run", status: run.status as RunStatus, startedAt: iso(run.startedAt), finishedAt: iso(run.finishedAt), warningCount: run.warningCount, failOnWarning: failOnWarningOf(run.options), url: runUrl(bot.workspaceSlug, run.id) });
  const group = await db.groupRun.findFirst({
    where: { id, workspaceId: bot.workspaceId },
    select: { id: true, status: true, createdAt: true, finishedAt: true, runs: { orderBy: [{ groupIndex: "asc" }, { id: "asc" }], select: { id: true, scenarioId: true, status: true, startedAt: true, warningCount: true, options: true } } },
  });
  if (!group) return null;
  const started = group.runs.map((r) => r.startedAt).filter((d): d is Date => d !== null);
  return withVerdict({
    id: group.id,
    kind: "group",
    status: group.status as RunStatus,
    startedAt: started.length ? iso(new Date(Math.min(...started.map((d) => d.getTime())))) : null,
    finishedAt: iso(group.finishedAt),
    warningCount: group.runs.reduce((n, r) => n + r.warningCount, 0),
    // A group's children share the options they were requested with.
    failOnWarning: failOnWarningOf(group.runs[0]?.options),
    // There is no group page; the first child's page shows the whole group.
    url: group.runs[0] ? runUrl(bot.workspaceSlug, group.runs[0].id) : null,
    children: group.runs.map((r) => ({ id: r.id, scenarioId: r.scenarioId, status: r.status as RunStatus, url: runUrl(bot.workspaceSlug, r.id) })),
  });
}

const failOnWarningOf = (options: unknown) => (options as { failOnWarning?: boolean } | null)?.failOnWarning === true;
const withVerdict = (run: Omit<ApiV1Run, "passed">): ApiV1Run => ({ ...run, passed: apiV1Passed(run) });

// --- Create ---------------------------------------------------------------------------

export function readApiIdempotencyKey(request: Request): string {
  const raw = request.headers.get(IDEMPOTENCY.header);
  if (raw === null) throw new ApiV1Error("invalid_request", `The ${IDEMPOTENCY.header} header is required`);
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) throw new ApiV1Error("invalid_request", `${IDEMPOTENCY.header} must be ${IDEMPOTENCY.minLength}–${IDEMPOTENCY.maxLength} characters`);
  return parsed.data;
}

/** Run options as stored: only the flags that are on, so `{}` and `{ video: false }` are the same request. */
function runOptionsOf(options: ApiV1RunOptions | undefined): ApiV1RunOptions {
  return { ...(options?.failOnWarning ? { failOnWarning: true } : {}), ...(options?.video ? { video: true } : {}) };
}

/** Canonical form: defaults filled, so `{}` and `{ mode: "sequential" }` are the same request. */
function requestHashOf(body: ApiV1CreateRun): string {
  const options = runOptionsOf(body.options);
  const canonical =
    "scenarioId" in body
      ? ["run", body.environmentId, body.scenarioId, options]
      : ["group", body.environmentId, "tag" in body ? { tag: body.tag } : { scenarioIds: body.scenarioIds }, body.mode ?? "sequential", body.continueOnFailure ?? false, options];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Unarchived scenarios of the tag on the environment's site, by name. */
async function scenarioIdsOfTag(tx: Tx, workspaceId: string, environmentId: string, tagName: string): Promise<string[]> {
  const environment = await tx.environment.findFirst({ where: { id: environmentId, workspaceId }, select: { siteId: true } });
  if (!environment) throw ApiError.notFound();
  const tag = await tx.tag.findFirst({ where: { workspaceId, name: tagName }, select: { id: true } });
  if (!tag) throw ApiError.notFound();
  const rows = await tx.scenario.findMany({ where: { workspaceId, siteId: environment.siteId, archivedAt: null, tags: { some: { tagId: tag.id } } }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true } });
  if (rows.length === 0) throw new ApiV1Error("invalid_request", `No scenarios of this environment's site carry the tag "${tagName}"`);
  return rows.map((r) => r.id);
}

/**
 * Under the creation lock: the token may have been revoked, expired or narrowed while this request waited.
 * `FOR SHARE` orders it against revoking, which locks the row for update.
 */
async function recheckToken(tx: Tx, botTokenId: string, scope: BotTokenScope): Promise<void> {
  const [row] = await tx.$queryRaw<{ revokedAt: Date | null; expiresAt: Date; scopes: string[] }[]>`
    SELECT "revokedAt", "expiresAt", scopes FROM "BotToken" WHERE id = ${botTokenId} FOR SHARE`;
  if (!row || row.revokedAt || row.expiresAt <= new Date()) throw new ApiV1Error("unauthenticated", "The bot token was revoked or expired");
  if (!row.scopes.includes(scope)) throw new ApiV1Error("forbidden", `This token lacks the ${scope} scope`);
}

/**
 * One transaction: workspace run lock → token re-check → this token's key row (an expired one is deleted and the key is new) →
 * creation → key row. The lock serialises concurrent requests with the same key, so only one creates; the
 * others read its target. A tag request keeps the scenarios chosen the first time.
 */
export async function createApiRun(bot: BotPrincipal, key: string, body: ApiV1CreateRun): Promise<{ run: ApiV1Run; created: boolean }> {
  const requestHash = requestHashOf(body);
  return getDb().$transaction(async (tx) => {
    await lockWorkspaceRuns(tx, bot.workspaceId);
    await recheckToken(tx, bot.botTokenId, "runs:create");
    const [existing] = await tx.$queryRaw<{ id: string; requestHash: string; runId: string | null; groupRunId: string | null; createdAt: Date }[]>`
      SELECT id, "requestHash", "runId", "groupRunId", "createdAt" FROM "ApiIdempotency"
      WHERE "botTokenId" = ${bot.botTokenId} AND key = ${key} FOR UPDATE`;
    if (existing && existing.createdAt.getTime() > Date.now() - IDEMPOTENCY.ttlMs) {
      if (existing.requestHash !== requestHash) throw new ApiV1Error("idempotency_conflict", `This ${IDEMPOTENCY.header} was already used for a different request`);
      const target = existing.groupRunId ?? existing.runId;
      const run = target ? await readApiRun(tx, bot, target) : null;
      if (!run) throw ApiError.notFound();
      return { run, created: false };
    }
    if (existing) await tx.apiIdempotency.delete({ where: { id: existing.id } });

    const isGroup = !("scenarioId" in body);
    const created = await createRunsInTx(tx, {
      workspaceId: bot.workspaceId,
      subject: { kind: "bot", botTokenId: bot.botTokenId },
      trigger: "api",
      requestHash,
      options: runOptionsOf(body.options),
      placement: { location: "server" },
      group: isGroup ? { environmentId: body.environmentId, mode: body.mode ?? "sequential", continueOnFailure: body.continueOnFailure ?? false } : undefined,
      async resolve(t) {
        const ids = "scenarioId" in body ? [body.scenarioId] : "tag" in body ? await scenarioIdsOfTag(t, bot.workspaceId, body.environmentId, body.tag) : body.scenarioIds;
        return resolveScenarioRuns(t, bot.workspaceId, body.environmentId, ids);
      },
    });
    await tx.apiIdempotency.create({ data: { botTokenId: bot.botTokenId, key, requestHash, runId: created.groupRunId ? null : created.runIds[0]!, groupRunId: created.groupRunId } });
    const run = await readApiRun(tx, bot, created.groupRunId ?? created.runIds[0]!);
    return { run: run!, created: true };
  });
}

/** Cleanup of key rows older than 24 hours; the worker runs it with its other cleanup jobs. */
export function deleteExpiredApiIdempotency(now = new Date()): Promise<number> {
  return deleteExpiredKeys(getDb(), IDEMPOTENCY.ttlMs, now);
}

// --- Wait -----------------------------------------------------------------------------

const TERMINAL = new Set<string>(["passed", "failed", "error", "cancelled", "timed_out"]);
const waits = { total: 0, perToken: new Map<string, number>() };

/** Test hook: the wait counters of this process. */
export function activeWaits(): { total: number; perToken: Map<string, number> } {
  return waits;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * `GET ?wait=<seconds>` (at most 60): reads once a second until the run ends or time is up, re-checking the
 * token and workspace each time. Stops when the client goes away. Concurrent waits are bounded per token and
 * per process (429 `too_many_waits`).
 */
export async function waitForApiRun(request: Request, bot: BotPrincipal, id: string, waitSeconds: number): Promise<ApiV1Run> {
  const first = await readApiRun(getDb(), bot, id);
  if (!first) throw ApiError.notFound();
  if (waitSeconds <= 0 || TERMINAL.has(first.status)) return first;
  const mine = waits.perToken.get(bot.botTokenId) ?? 0;
  if (mine >= API_V1_WAIT.perToken || waits.total >= API_V1_WAIT.total) throw new ApiV1Error("too_many_waits", "Too many waiting requests; try again shortly");
  waits.total += 1;
  waits.perToken.set(bot.botTokenId, mine + 1);
  try {
    const deadline = Date.now() + Math.min(waitSeconds, API_V1_WAIT.maxSeconds) * 1000;
    let current = first;
    while (Date.now() < deadline && !request.signal.aborted) {
      await sleep(Math.min(API_V1_WAIT.pollMs, deadline - Date.now()), request.signal);
      if (request.signal.aborted) break;
      const again = await verifyBotToken(bearer(request), false);
      if (!again || again.botTokenId !== bot.botTokenId) throw new ApiV1Error("unauthenticated", "The bot token was revoked or expired");
      const run = await readApiRun(getDb(), bot, id);
      if (!run) throw ApiError.notFound();
      current = run;
      if (TERMINAL.has(run.status)) break;
    }
    return current;
  } finally {
    waits.total -= 1;
    const left = (waits.perToken.get(bot.botTokenId) ?? 1) - 1;
    if (left > 0) waits.perToken.set(bot.botTokenId, left);
    else waits.perToken.delete(bot.botTokenId);
  }
}

// --- Cancel ---------------------------------------------------------------------------

/** A run, or every unfinished child of a group, like the web cancel. */
export async function cancelApiRun(bot: BotPrincipal, id: string): Promise<ApiV1Run> {
  const db = getDb();
  const found = await readApiRun(db, bot, id);
  if (!found) throw ApiError.notFound();
  const runIds = found.kind === "group" ? found.children!.filter((c) => !TERMINAL.has(c.status)).map((c) => c.id) : [found.id];
  for (const runId of runIds) await requestCancel(db, bot.workspaceId, runId);
  return (await readApiRun(db, bot, id))!;
}
