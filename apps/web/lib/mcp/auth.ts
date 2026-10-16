// MCP tokens (stage 6 contract section 3): the desktop app's bearer token for `/api/mcp/*`, acting as its user
// with that user's permissions. 30 days, one device, sha256 stored. Refresh hands out a new token; the older
// ones of the device are revoked when the new one is first used (proof the app stored it), a minute later.
import { createHash, randomBytes } from "node:crypto";
import { can, type Action, type Role } from "@defe2end/shared";
import type { Prisma } from "@defe2end/db";
import type { SessionActor } from "../actor";
import { errorResponse, runAs, toErrorResponse, type RouteContext, type RouteSpec } from "../api";
import { getDb } from "../db";

export const MCP_TOKEN_PREFIX = "mcp_";
export const MCP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A refreshed token's predecessor keeps working this long after the new one is first used (requests in flight). */
export const MCP_TOKEN_OVERLAP_MS = 60_000;
const LAST_USED_EVERY_MS = 60_000;

export function hashMcpToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type McpClientHint = "claude" | "codex";

/** A new token for the user's device. Callers make sure the device is the user's. */
export async function issueMcpToken(db: Pick<ReturnType<typeof getDb>, "mcpToken">, input: { userId: string; deviceId: string; clientHint?: McpClientHint | null }) {
  const raw = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + MCP_TOKEN_TTL_MS);
  await db.mcpToken.create({ data: { userId: input.userId, deviceId: input.deviceId, tokenHash: hashMcpToken(raw), prefix: raw.slice(0, 8), expiresAt, clientHint: input.clientHint ?? null } });
  return { token: raw, expiresAt: expiresAt.toISOString() };
}

export interface McpPrincipal {
  tokenId: string;
  userId: string;
  deviceId: string;
}

/** Live = not revoked (or revoked in the future), not expired, user active, device still the user's. */
export async function verifyMcpToken(raw: string | null): Promise<McpPrincipal | null> {
  if (!raw?.startsWith(MCP_TOKEN_PREFIX)) return null;
  const db = getDb();
  const row = await db.mcpToken.findUnique({
    where: { tokenHash: hashMcpToken(raw) },
    select: { id: true, userId: true, deviceId: true, expiresAt: true, revokedAt: true, lastUsedAt: true, createdAt: true, user: { select: { disabledAt: true } }, device: { select: { userId: true } } },
  });
  const now = new Date();
  if (!row || (row.revokedAt && row.revokedAt <= now) || row.expiresAt <= now || row.user.disabledAt || row.device.userId !== row.userId) return null;
  if (!row.lastUsedAt) {
    // First use of a refreshed token: its device's older live tokens end after the overlap.
    await db.mcpToken.updateMany({
      where: { deviceId: row.deviceId, id: { not: row.id }, createdAt: { lte: row.createdAt }, OR: [{ revokedAt: null }, { revokedAt: { gt: new Date(now.getTime() + MCP_TOKEN_OVERLAP_MS) } }] },
      data: { revokedAt: new Date(now.getTime() + MCP_TOKEN_OVERLAP_MS) },
    });
  }
  if (!row.lastUsedAt || row.lastUsedAt.getTime() < now.getTime() - LAST_USED_EVERY_MS) {
    await db.mcpToken.update({ where: { id: row.id }, data: { lastUsedAt: now } });
  }
  return { tokenId: row.id, userId: row.userId, deviceId: row.deviceId };
}

type Db = ReturnType<typeof getDb>;
export type McpTx = Prisma.TransactionClient;

/**
 * Issue, refresh and revoke of a device's MCP tokens take the device row lock (in id order), so a revocation
 * can't land between a refresh's authentication and its new token. Callers re-check state after locking.
 */
export async function lockMcpDevices(tx: McpTx, where: { userId: string } | { deviceId: string }): Promise<string[]> {
  const rows =
    "deviceId" in where
      ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "DesktopDevice" WHERE id = ${where.deviceId} ORDER BY id FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "DesktopDevice" WHERE "userId" = ${where.userId} ORDER BY id FOR UPDATE`;
  return rows.map((r) => r.id);
}

/** The token is still live: not revoked (or revoked in the future), not expired, user active, device still the user's. */
export async function isMcpTokenLive(db: McpTx | Db, tokenId: string): Promise<boolean> {
  const row = await db.mcpToken.findUnique({
    where: { id: tokenId },
    select: { userId: true, expiresAt: true, revokedAt: true, user: { select: { disabledAt: true } }, device: { select: { userId: true } } },
  });
  const now = new Date();
  return !!row && !(row.revokedAt && row.revokedAt <= now) && row.expiresAt > now && !row.user.disabledAt && row.device.userId === row.userId;
}

/** Revokes every live MCP token of the user, or of one device (web sign-out, account disabled, app logout), under the device lock. */
export async function revokeMcpTokens(db: Db | McpTx, where: { userId: string } | { deviceId: string }): Promise<number> {
  const revoke = async (tx: McpTx) => {
    await lockMcpDevices(tx, where);
    const now = new Date();
    const { count } = await tx.mcpToken.updateMany({ where: { ...where, OR: [{ revokedAt: null }, { revokedAt: { gt: now } }] }, data: { revokedAt: now } });
    return count;
  };
  return "$transaction" in db ? db.$transaction(revoke) : revoke(db);
}

/** For long-running MCP requests (`get_run` wait): the token is still live and its user may still do `action` there. */
export async function mcpStillAllowed(principal: McpPrincipal, action: Action, workspaceId: string): Promise<boolean> {
  if (!(await isMcpTokenLive(getDb(), principal.tokenId))) return false;
  const actor = await actorOf(principal);
  return !!actor && can(actor, action, { type: "run", workspaceId }) === "allow";
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match ? match[1]! : null;
}

/** The token's user as a route actor (memberships loaded now), null when disabled. */
async function actorOf(principal: McpPrincipal): Promise<SessionActor | null> {
  const user = await getDb().user.findUnique({ where: { id: principal.userId }, select: { id: true, name: true, email: true, isInstanceAdmin: true, disabledAt: true, memberships: { select: { workspaceId: true, role: true } } } });
  if (!user || user.disabledAt) return null;
  const roles: Record<string, Role> = {};
  for (const m of user.memberships) roles[m.workspaceId] = m.role;
  return { userId: user.id, isInstanceAdmin: user.isInstanceAdmin, roles, user: { id: user.id, name: user.name, email: user.email }, sessionId: `mcp:${principal.tokenId}` };
}

type Params = Record<string, string | string[] | undefined>;
export type McpHandler = (ctx: RouteContext<any> & { mcp: McpPrincipal }) => Promise<Response> | Response;
type WebRoute = { routeSpec: RouteSpec; inner: (ctx: RouteContext<any>) => Promise<Response> | Response };

/**
 * The only way to write an `/api/mcp/*` route: MCP token (session cookies and bot tokens are refused) → its
 * user → the same workspace and `can()` checks as session routes → handler. Pass a session route to re-expose
 * its handler unchanged, or a spec and a handler for MCP-only operations.
 */
export function mcpRoute(web: WebRoute): ReturnType<typeof wrap>;
export function mcpRoute(spec: RouteSpec, handler: McpHandler): ReturnType<typeof wrap>;
export function mcpRoute(a: WebRoute | RouteSpec, handler?: McpHandler) {
  return "inner" in a ? wrap(a.routeSpec, a.inner as McpHandler) : wrap(a, handler!);
}

function wrap(spec: RouteSpec, handler: McpHandler) {
  const wrapped = async (request: Request, context: { params: Promise<Params> }) => {
    try {
      const principal = await verifyMcpToken(bearer(request));
      if (!principal) return errorResponse("unauthenticated", "A valid MCP token is required");
      const actor = await actorOf(principal);
      if (!actor) return errorResponse("unauthenticated", "A valid MCP token is required");
      return await runAs(spec, (ctx) => handler({ ...ctx, mcp: principal }), request, await context.params, actor);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
  return Object.assign(wrapped, { routeSpec: spec, mcpAuth: true as const });
}
