import type { Prisma } from "@defe2end/db";
import { ApiError } from "../api";
import { getDb } from "../db";

/**
 * One instance-wide lock for "who is an active ADMIN": every write to Membership or User.disabledAt
 * (role change, remove, disable/enable, invite accept, workspace create/delete, setup, CLI create-admin)
 * takes it first, then reads fresh state and validates. Per-row or per-workspace locks chosen from a
 * pre-read can always race with another membership change; admin operations are rare, so serializing them
 * all is cheap and leaves no ordering to get wrong. Keep the key in sync with cli/defe2end.mjs.
 * `admin-lock.int.test.ts` fails if a source file writes Membership or disabledAt without calling this.
 */
export const ADMIN_MEMBERSHIP_LOCK = 1684366642;

/** Call first inside the transaction, before reading any membership or user state. */
export async function lockAdminMembership(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_MEMBERSHIP_LOCK}::bigint)`;
}

/** What the acting user must still be once the lock is held. */
export type ActorRequirement =
  | { kind: "active" }
  | { kind: "instanceAdmin" }
  | { kind: "workspaceAdmin"; workspaceId: string };

/**
 * Takes the lock, then re-reads the acting user inside the transaction: route() checked them before the
 * request queued on the lock, and a change committed meanwhile (disabled, demoted, removed) must win.
 * Disabled or gone → 401, no longer allowed → 403 (404 if no longer a member, like route()).
 * Every path with a session actor uses this; plain `lockAdminMembership` is only for setup and the CLI.
 */
export async function lockAndRevalidateActor(tx: Prisma.TransactionClient, actorId: string, requirement: ActorRequirement): Promise<void> {
  await lockAdminMembership(tx);
  const user = await tx.user.findUnique({ where: { id: actorId }, select: { disabledAt: true, isInstanceAdmin: true } });
  if (!user || user.disabledAt) throw new ApiError("unauthenticated", "Sign in required");
  if (requirement.kind === "instanceAdmin" && !user.isInstanceAdmin) throw new ApiError("forbidden", "Forbidden");
  if (requirement.kind === "workspaceAdmin") {
    const membership = await tx.membership.findUnique({
      where: { userId_workspaceId: { userId: actorId, workspaceId: requirement.workspaceId } },
      select: { role: true },
    });
    if (!membership) throw ApiError.notFound();
    if (membership.role !== "ADMIN") throw new ApiError("forbidden", "Your role does not allow this");
  }
}

/** Opens a transaction, takes the lock and re-validates the actor, then runs `fn`. */
export function withLockedActor<T>(actorId: string, requirement: ActorRequirement, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return getDb().$transaction(async (tx) => {
    await lockAndRevalidateActor(tx, actorId, requirement);
    return fn(tx);
  });
}
