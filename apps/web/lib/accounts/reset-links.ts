import { randomBytes } from "node:crypto";
import { generateLinkToken, hashLinkToken, LINK_TOKEN_TTL_MS } from "@defe2end/shared/server";
import { z } from "zod";
import { ApiError } from "../api";
import { audit } from "../audit";
import { getDb } from "../db";
import { revokeUserDesktopTokens } from "../desktop/auth";
import { LinkError, linkState } from "./invites";
import { withLockedActor } from "./admin-lock";
import { activeAdminMembershipIds } from "./members";
import { hashNewPassword } from "./password-user";

/**
 * Issues a one-time reset link and revokes the user's older unused ones. Runs under the shared admin lock
 * with the issuer re-validated, so an instance admin disabled or demoted while the request waited gets no token.
 * The CLI (cli/defe2end.mjs) mirrors this logic without a session actor.
 */
export async function issueResetLink(input: { userId: string; actorId: string }) {
  const token = generateLinkToken();
  const link = await withLockedActor(input.actorId, { kind: "instanceAdmin" }, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!user) throw ApiError.notFound();
    await tx.resetLink.updateMany({ where: { userId: user.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const created = await tx.resetLink.create({
      data: {
        userId: user.id,
        tokenHash: hashLinkToken(token),
        expiresAt: new Date(Date.now() + LINK_TOKEN_TTL_MS.reset),
        createdById: input.actorId,
      },
    });
    await audit({ actorId: input.actorId, action: "user.reset_link.issue", targetType: "user", targetId: user.id, meta: { via: "web" } }, tx);
    return created;
  });
  return { token, expiresAt: link.expiresAt.toISOString() };
}

export async function inspectResetLink(token: string) {
  const link = await getDb().resetLink.findUnique({ where: { tokenHash: hashLinkToken(token) }, include: { user: { select: { email: true } } } });
  const state = linkState(link);
  return state === "valid" ? { state, email: link!.user.email } : { state };
}

export const resetInputSchema = z.object({ password: z.string().min(8).max(128) });

/**
 * Uses a reset link: sets the password (creating the password login if the account had none),
 * deletes every session of that user, and records it. One request wins the conditional update.
 */
export async function useResetLink(token: string, password: string): Promise<{ email: string }> {
  const tokenHash = hashLinkToken(token);
  // Cheap lookup first: a bad token must not cost a (deliberately slow) password hash.
  const state = linkState(await getDb().resetLink.findUnique({ where: { tokenHash } }));
  if (state !== "valid") throw new LinkError(state);
  const hash = await hashNewPassword(password);
  return getDb().$transaction(async (tx) => {
    const now = new Date();
    const claimed = await tx.resetLink.updateMany({
      where: { tokenHash, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    const link = await tx.resetLink.findUnique({ where: { tokenHash }, include: { user: { select: { id: true, email: true } } } });
    if (claimed.count !== 1 || !link) {
      const state = linkState(link);
      throw new LinkError(state === "valid" ? "used" : state);
    }
    const userId = link.user.id;
    await tx.account.upsert({
      where: { providerId_accountId: { providerId: "credential", accountId: userId } },
      create: { id: randomBytes(16).toString("hex"), providerId: "credential", accountId: userId, userId, password: hash },
      update: { password: hash },
    });
    const { count } = await tx.session.deleteMany({ where: { userId } });
    await audit({ actorId: null, action: "user.password_reset", targetType: "user", targetId: userId, meta: { resetLinkId: link.id, sessionsRevoked: count } }, tx);
    return { email: link.user.email };
  });
}

export async function listUsers() {
  const users = await getDb().user.findMany({
    select: { id: true, name: true, email: true, isInstanceAdmin: true, disabledAt: true, createdAt: true, _count: { select: { memberships: true } } },
    orderBy: { createdAt: "asc" },
  });
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    isInstanceAdmin: u.isInstanceAdmin,
    disabled: Boolean(u.disabledAt),
    workspaceCount: u._count.memberships,
    createdAt: u.createdAt.toISOString(),
  }));
}

/**
 * Disabling signs the user out everywhere. You can't disable yourself, the last enabled instance admin,
 * or the only active ADMIN of any workspace.
 */
export async function setUserDisabled(input: { userId: string; disabled: boolean; actorId: string }) {
  if (input.userId === input.actorId) throw new ApiError("conflict", "You can't disable your own account");
  await withLockedActor(input.actorId, { kind: "instanceAdmin" }, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) throw ApiError.notFound();
    if (input.disabled && user.isInstanceAdmin) {
      const admins = await tx.user.count({ where: { isInstanceAdmin: true, disabledAt: null } });
      if (admins <= 1) throw new ApiError("conflict", "At least one instance admin must stay enabled");
    }
    if (input.disabled) {
      // Under the shared lock nothing can change memberships meanwhile: each administered workspace must keep another active admin.
      const administered = await tx.membership.findMany({ where: { userId: user.id, role: "ADMIN" }, select: { workspaceId: true } });
      for (const { workspaceId } of administered) {
        const others = (await activeAdminMembershipIds(tx, workspaceId)).filter((m) => m.userId !== user.id);
        if (others.length === 0) throw new ApiError("conflict", "This user is the only active admin of a workspace");
      }
    }
    if (Boolean(user.disabledAt) === input.disabled) return;
    await tx.user.update({ where: { id: user.id }, data: { disabledAt: input.disabled ? new Date() : null } });
    if (input.disabled) await tx.session.deleteMany({ where: { userId: user.id } });
    // Its desktop app tokens go too (stage 4 contract section 9); open streams close on their next poll.
    if (input.disabled) await revokeUserDesktopTokens(user.id, tx);
    await audit({ actorId: input.actorId, action: input.disabled ? "user.disable" : "user.enable", targetType: "user", targetId: user.id }, tx);
  });
}
