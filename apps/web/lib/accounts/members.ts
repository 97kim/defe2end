import { ROLES, type Role } from "@defe2end/shared";
import type { Prisma } from "@defe2end/db";
import { z } from "zod";
import { ApiError } from "../api";
import { audit } from "../audit";
import { getDb } from "../db";
import { withLockedActor } from "./admin-lock";

export const roleSchema = z.enum(ROLES);

export async function listMembers(workspaceId: string) {
  const rows = await getDb().membership.findMany({
    where: { workspaceId },
    select: { id: true, role: true, createdAt: true, user: { select: { id: true, name: true, email: true, disabledAt: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    joinedAt: m.createdAt.toISOString(),
    user: { id: m.user.id, name: m.user.name, email: m.user.email, disabled: Boolean(m.user.disabledAt) },
  }));
}

/** ADMIN memberships whose user is not disabled. Read only while holding `lockAdminMembership`. */
export async function activeAdminMembershipIds(tx: Prisma.TransactionClient, workspaceId: string): Promise<{ id: string; userId: string }[]> {
  return tx.membership.findMany({ where: { workspaceId, role: "ADMIN", user: { disabledAt: null } }, select: { id: true, userId: true } });
}

/**
 * Runs `change` under the shared lock, after re-checking that `actorId` is still an active ADMIN here,
 * with a fresh list of the workspace's active ADMIN memberships.
 */
function withActiveAdmins<T>(workspaceId: string, actorId: string, change: (tx: Prisma.TransactionClient, activeAdminIds: string[]) => Promise<T>) {
  return withLockedActor(actorId, { kind: "workspaceAdmin", workspaceId }, async (tx) =>
    change(tx, (await activeAdminMembershipIds(tx, workspaceId)).map((a) => a.id)),
  );
}

/** True when `membershipId` is the workspace's only active admin. */
const isLastActiveAdmin = (activeAdminIds: string[], membershipId: string) =>
  activeAdminIds.includes(membershipId) && activeAdminIds.length <= 1;

const LAST_ADMIN = "A workspace needs at least one active admin";

export async function changeRole(input: { workspaceId: string; membershipId: string; role: Role; actorId: string }) {
  return withActiveAdmins(input.workspaceId, input.actorId, async (tx, activeAdminIds) => {
    const member = await tx.membership.findFirst({ where: { id: input.membershipId, workspaceId: input.workspaceId } });
    if (!member) throw ApiError.notFound();
    if (member.role === input.role) return member;
    if (input.role !== "ADMIN" && isLastActiveAdmin(activeAdminIds, member.id)) throw new ApiError("conflict", LAST_ADMIN);
    const updated = await tx.membership.update({ where: { id: member.id }, data: { role: input.role } });
    await audit(
      {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: "member.role_change",
        targetType: "user",
        targetId: member.userId,
        meta: { from: member.role, to: input.role },
      },
      tx,
    );
    return updated;
  });
}

export async function removeMember(input: { workspaceId: string; membershipId: string; actorId: string }) {
  await withActiveAdmins(input.workspaceId, input.actorId, async (tx, activeAdminIds) => {
    const member = await tx.membership.findFirst({ where: { id: input.membershipId, workspaceId: input.workspaceId } });
    if (!member) throw ApiError.notFound();
    if (isLastActiveAdmin(activeAdminIds, member.id)) throw new ApiError("conflict", LAST_ADMIN);
    await tx.membership.delete({ where: { id: member.id } });
    await audit(
      {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: "member.remove",
        targetType: "user",
        targetId: member.userId,
        meta: { role: member.role },
      },
      tx,
    );
  });
}
