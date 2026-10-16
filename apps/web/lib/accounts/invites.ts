import { generateLinkToken, hashLinkToken, LINK_TOKEN_TTL_MS } from "@defe2end/shared/server";
import type { Role } from "@defe2end/shared";
import { z } from "zod";
import { ApiError, toErrorResponse } from "../api";
import { audit } from "../audit";
import { getDb } from "../db";
import { createPasswordUser } from "../users";
import { withLockedActor } from "./admin-lock";
import { roleSchema } from "./members";

export const inviteInputSchema = z.object({
  email: z.email().max(254),
  role: roleSchema,
});

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Why a link can't be used. Shown to whoever holds the token, never to anyone else. */
export type LinkState = "valid" | "invalid" | "expired" | "used" | "revoked";

export function linkState(link: { expiresAt: Date; usedAt: Date | null; revokedAt: Date | null } | null, now = new Date()): LinkState {
  if (!link) return "invalid";
  if (link.usedAt) return "used";
  if (link.revokedAt) return "revoked";
  if (link.expiresAt <= now) return "expired";
  return "valid";
}

export class LinkError extends ApiError {
  constructor(readonly state: Exclude<LinkState, "valid"> | "wrong_account") {
    super(state === "wrong_account" ? "forbidden" : state === "invalid" ? "not_found" : "conflict", `Link ${state}`);
  }
}

/** Link errors carry `state` so the page can say why (expired / used / revoked / wrong account). */
export function linkErrorResponse(err: unknown): Response {
  const res = toErrorResponse(err);
  if (!(err instanceof LinkError)) return res;
  return Response.json({ error: { code: err.code, message: err.message, state: err.state } }, { status: res.status });
}

export async function listPendingInvites(workspaceId: string) {
  const rows = await getDb().invite.findMany({
    where: { workspaceId, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true, createdBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    expiresAt: i.expiresAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
    createdBy: i.createdBy.name,
  }));
}

/** Issues an invite; the token is returned once and only its hash is stored. A newer invite replaces older pending ones for the same email. */
export async function createInvite(input: { workspaceId: string; email: string; role: Role; actorId: string }) {
  const email = normalizeEmail(input.email);
  const token = generateLinkToken();
  // An invite can hand out ADMIN, so the issuer must still be an active ADMIN once the lock is held.
  const invite = await withLockedActor(input.actorId, { kind: "workspaceAdmin", workspaceId: input.workspaceId }, async (tx) => {
    const already = await tx.membership.findFirst({ where: { workspaceId: input.workspaceId, user: { email } } });
    if (already) throw new ApiError("conflict", "This person is already a member");
    await tx.invite.updateMany({
      where: { workspaceId: input.workspaceId, email, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const created = await tx.invite.create({
      data: {
        workspaceId: input.workspaceId,
        email,
        role: input.role,
        tokenHash: hashLinkToken(token),
        expiresAt: new Date(Date.now() + LINK_TOKEN_TTL_MS.invite),
        createdById: input.actorId,
      },
    });
    await audit(
      { workspaceId: input.workspaceId, actorId: input.actorId, action: "invite.create", targetType: "invite", targetId: created.id, meta: { email, role: input.role } },
      tx,
    );
    return created;
  });
  return { id: invite.id, email, role: invite.role, expiresAt: invite.expiresAt.toISOString(), token };
}

export async function revokeInvite(input: { workspaceId: string; inviteId: string; actorId: string }) {
  const db = getDb();
  const invite = await db.invite.findFirst({ where: { id: input.inviteId, workspaceId: input.workspaceId } });
  if (!invite) throw ApiError.notFound();
  const res = await db.invite.updateMany({ where: { id: invite.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  if (res.count !== 1) throw new ApiError("conflict", "This invite was already used or revoked");
  await audit({ workspaceId: input.workspaceId, actorId: input.actorId, action: "invite.revoke", targetType: "invite", targetId: invite.id, meta: { email: invite.email } });
}

async function findByToken(token: string) {
  // Lookup by hash is an index hit on a SHA-256 digest, so it can't be used to guess tokens.
  return getDb().invite.findUnique({ where: { tokenHash: hashLinkToken(token) }, include: { workspace: { select: { name: true, slug: true } } } });
}

/** What the invite page shows before acting. Never consumes the link. */
export async function inspectInvite(token: string) {
  const invite = await findByToken(token);
  const state = linkState(invite);
  if (!invite || state !== "valid") return { state };
  const hasAccount = (await getDb().user.count({ where: { email: invite.email } })) > 0;
  return { state, email: invite.email, role: invite.role, workspace: invite.workspace.name, hasAccount };
}

/**
 * Consumes the invite and adds the membership in one transaction. The conditional update
 * succeeds for exactly one request (contract section 5); anything else maps to the link's state.
 */
async function consume(token: string, userId: string): Promise<{ slug: string }> {
  // The accepting user must still be active once the lock is held.
  return withLockedActor(userId, { kind: "active" }, async (tx) => {
    const now = new Date();
    const claimed = await tx.invite.updateMany({
      where: { tokenHash: hashLinkToken(token), usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    const invite = await tx.invite.findUnique({ where: { tokenHash: hashLinkToken(token) }, include: { workspace: true } });
    if (claimed.count !== 1 || !invite) {
      const state = linkState(invite);
      throw new LinkError(state === "valid" ? "used" : state);
    }
    const existing = await tx.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId: invite.workspaceId } } });
    if (existing) throw new ApiError("conflict", "You're already a member of this workspace");
    await tx.membership.create({ data: { userId, workspaceId: invite.workspaceId, role: invite.role } });
    await audit(
      { workspaceId: invite.workspaceId, actorId: userId, action: "invite.accept", targetType: "invite", targetId: invite.id, meta: { email: invite.email, role: invite.role } },
      tx,
    );
    return { slug: invite.workspace.slug };
  });
}

/** Signed-in path: the account's email must match the invite (case-insensitive). */
export async function acceptInviteAsUser(token: string, user: { id: string; email: string }) {
  const invite = await findByToken(token);
  const state = linkState(invite);
  if (state !== "valid") throw new LinkError(state);
  if (normalizeEmail(user.email) !== invite!.email) throw new LinkError("wrong_account");
  return consume(token, user.id);
}

export const signupInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(128),
});

/** Signed-out path: creates a password account bound to the invite email, then joins. */
export async function acceptInviteWithNewAccount(token: string, input: z.infer<typeof signupInputSchema>) {
  const invite = await findByToken(token);
  const state = linkState(invite);
  if (state !== "valid") throw new LinkError(state);
  const db = getDb();
  if (await db.user.count({ where: { email: invite!.email } })) {
    throw new ApiError("conflict", "An account with this email already exists. Sign in to accept.");
  }
  const user = await createPasswordUser({ email: invite!.email, name: input.name, password: input.password });
  try {
    const result = await consume(token, user.id);
    return { ...result, email: user.email };
  } catch (err) {
    // Lost a race for the link: don't leave an account that nobody invited.
    await db.user.delete({ where: { id: user.id } });
    throw err;
  }
}
