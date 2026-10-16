// Target-site login sessions (stage 4 contract section 5). Stored encrypted with the install key (like secret
// variables), keyed environment × user, at most 512KB, and expired at the earlier of 30 days after saving and
// the latest expiring target-host cookie. Only their owner sees (metadata only), uses or deletes them; cookie
// values never reach a log — counts only.
import { authSessionRegisterSchema, can, type AuthSessionRegister, type AuthSessionTarget, type Role, type StorageState } from "@defe2end/shared";
import { ApiError } from "./api";
import { audit } from "./audit";
import { getDb } from "./db";
import { encrypt } from "./encryption";

export const AUTH_SESSION_MAX_BYTES = 512 * 1024;
export const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;


/** A cookie for `host` itself or one of its parent domains (`.example.com` covers `shop.example.com`). */
export function cookieMatchesHost(domain: string, host: string): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** Earlier of savedAt + 30 days and the latest expiry among the target host's cookies that have one. */
export function authSessionExpiry(state: StorageState, baseUrl: string, savedAt: Date): Date {
  const ttl = savedAt.getTime() + AUTH_SESSION_TTL_MS;
  const host = new URL(baseUrl).hostname;
  const expiries = state.cookies.filter((c) => c.expires > 0 && cookieMatchesHost(c.domain, host)).map((c) => c.expires * 1000);
  return new Date(expiries.length > 0 ? Math.min(ttl, Math.max(...expiries)) : ttl);
}

export function authSessionView(s: { id: string; environmentId: string; cookieCount: number; sizeBytes: number; savedAt: Date; expiresAt: Date }) {
  return { id: s.id, environmentId: s.environmentId, cookieCount: s.cookieCount, sizeBytes: s.sizeBytes, savedAt: s.savedAt.toISOString(), expiresAt: s.expiresAt.toISOString() };
}

/** The owner is the token's user, who must still hold `authSession.write` in the workspace (else 404/403). */
type Owner = { userId: string } | { scheduleId: string } | { botTokenId: string };

/**
 * Who may save (or capture) a session for `target` in this workspace, and the owner key it is stored under:
 * the person themself (`authSession.write`), a schedule of this environment (`schedule.write`) or a live bot
 * token of this workspace (`botToken.write`). Unknown or foreign targets are 404.
 */
export async function authorizeSessionTarget(userId: string, workspaceId: string, environmentId: string, target: AuthSessionTarget = { kind: "user" }): Promise<Owner> {
  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { disabledAt: true, isInstanceAdmin: true, memberships: { where: { workspaceId }, select: { role: true } } },
  });
  if (!user || user.disabledAt) throw new ApiError("unauthenticated", "Sign in required");
  const role = user.memberships[0]?.role;
  const roles: Record<string, Role> = role ? { [workspaceId]: role } : {};
  const action = target.kind === "user" ? "authSession.write" : target.kind === "schedule" ? "schedule.write" : "botToken.write";
  const decision = can({ userId, isInstanceAdmin: user.isInstanceAdmin, roles }, action, { type: target.kind === "user" ? "authSession" : target.kind === "schedule" ? "schedule" : "botToken", workspaceId });
  if (decision === "not_found") throw ApiError.notFound();
  if (decision === "forbidden") throw new ApiError("forbidden", "Your role does not allow this");
  if (target.kind === "schedule") {
    const schedule = await db.schedule.findFirst({ where: { id: target.scheduleId, workspaceId, environmentId }, select: { id: true } });
    if (!schedule) throw ApiError.notFound();
    return { scheduleId: schedule.id };
  }
  if (target.kind === "bot") {
    const bot = await db.botToken.findFirst({ where: { id: target.botTokenId, workspaceId, revokedAt: null }, select: { id: true } });
    if (!bot) throw ApiError.notFound();
    return { botTokenId: bot.id };
  }
  return { userId };
}

const ownerWhere = (environmentId: string, owner: Owner) =>
  "userId" in owner
    ? { environmentId_userId: { environmentId, userId: owner.userId } }
    : "scheduleId" in owner
      ? { environmentId_scheduleId: { environmentId, scheduleId: owner.scheduleId } }
      : { environmentId_botTokenId: { environmentId, botTokenId: owner.botTokenId } };

/**
 * Registers a captured session. The target came back unchanged from the capture request; the right to it is
 * checked again now (the token's user may have lost it meanwhile). Stored under the target's own unique key.
 */
export async function saveAuthSession(userId: string, input: AuthSessionRegister) {
  const db = getDb();
  const environment = await db.environment.findFirst({ where: { id: input.environmentId, workspaceId: input.workspaceId }, select: { id: true, baseUrl: true } });
  if (!environment) {
    // Same answer as a missing workspace membership: nothing about other workspaces leaks.
    await authorizeSessionTarget(userId, input.workspaceId, input.environmentId, { kind: "user" });
    throw ApiError.notFound();
  }
  const owner = await authorizeSessionTarget(userId, input.workspaceId, environment.id, input.target);

  const state = input.storageState;
  if (state.cookies.length === 0) throw new ApiError("invalid_request", "The session has no cookies. Sign in to the site first.");
  const plain = JSON.stringify(state);
  const sizeBytes = Buffer.byteLength(plain);
  if (sizeBytes > AUTH_SESSION_MAX_BYTES) throw new ApiError("payload_too_large", "The login session is larger than 512KB.");
  const savedAt = new Date();
  const data = { encryptedState: encrypt(plain), cookieCount: state.cookies.length, sizeBytes, savedAt, expiresAt: authSessionExpiry(state, environment.baseUrl, savedAt) };
  const saved = await db.$transaction(async (tx) => {
    const s = await tx.authSession.upsert({
      where: ownerWhere(environment.id, owner),
      create: { workspaceId: input.workspaceId, environmentId: environment.id, ...owner, ...data },
      update: data,
    });
    await audit({ workspaceId: input.workspaceId, actorId: userId, action: "authSession.save", targetType: "environment", targetId: environment.id, meta: { cookieCount: data.cookieCount, owner: Object.keys(owner)[0]!, ownerId: Object.values(owner)[0]! } }, tx);
    return s;
  });
  return { ...authSessionView(saved), ...(input.requestId ? { requestId: input.requestId } : {}), ...(input.target ? { target: input.target } : {}) };
}

export async function listOwnAuthSessions(workspaceId: string, userId: string) {
  const rows = await getDb().authSession.findMany({ where: { workspaceId, userId }, orderBy: { savedAt: "desc" } });
  return rows.map(authSessionView);
}

/** Someone else's session (or another workspace's) is a 404. */
export async function deleteOwnAuthSession(workspaceId: string, userId: string, id: string): Promise<void> {
  const db = getDb();
  await db.$transaction(async (tx) => {
    const { count } = await tx.authSession.deleteMany({ where: { id, workspaceId, userId } });
    if (count === 0) throw ApiError.notFound();
    await audit({ workspaceId, actorId: userId, action: "authSession.delete", targetType: "authSession", targetId: id }, tx);
  });
}

export { authSessionRegisterSchema, type AuthSessionRegister };
