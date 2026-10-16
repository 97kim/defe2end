import { hashLinkToken, verifyLinkToken } from "@defe2end/shared/server";
import { z } from "zod";
import { ApiError } from "./api";
import { audit } from "./audit";
import { getDb } from "./db";
import { slugify } from "./slug";
import { lockAdminMembership } from "./accounts/admin-lock";
import { hashNewPassword, insertPasswordUser } from "./accounts/password-user";

export const setupInputSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  password: z.string().min(8).max(128),
  workspaceName: z.string().trim().min(1).max(100),
});

export async function isSetupDone(): Promise<boolean> {
  return (await getDb().user.count({ where: { isInstanceAdmin: true } })) > 0;
}

/**
 * Creates the first instance admin and workspace with the install token (contract section 2).
 * One transaction: admin, credential, workspace, membership and the used token commit together or not at all,
 * under the shared admin-membership lock (also taken by `defe2end admin create-admin`), so a crash or a concurrent CLI run can't leave two
 * admins or an admin without a workspace.
 */
export async function completeSetup(input: z.infer<typeof setupInputSchema>): Promise<{ userId: string; slug: string }> {
  const db = getDb();
  const setting = await db.instanceSetting.findUnique({ where: { id: 1 } });
  if (!setting?.installTokenHash || setting.installTokenUsedAt || !verifyLinkToken(input.token, setting.installTokenHash)) {
    throw new ApiError("forbidden", "Invalid or used install token");
  }
  const passwordHash = await hashNewPassword(input.password);
  return db.$transaction(async (tx) => {
    await lockAdminMembership(tx);
    if (await tx.user.count({ where: { isInstanceAdmin: true } })) throw new ApiError("forbidden", "Invalid or used install token");
    // Single use: only one request can flip installTokenUsedAt (rolled back with everything else on failure).
    const claimed = await tx.instanceSetting.updateMany({
      where: { id: 1, installTokenHash: hashLinkToken(input.token), installTokenUsedAt: null },
      data: { installTokenUsedAt: new Date() },
    });
    if (claimed.count !== 1) throw new ApiError("forbidden", "Invalid or used install token");
    const user = await insertPasswordUser(tx, { email: input.email, name: input.name, isInstanceAdmin: true }, passwordHash);
    const ws = await tx.workspace.create({ data: { name: input.workspaceName, slug: slugify(input.workspaceName) } });
    await tx.membership.create({ data: { userId: user.id, workspaceId: ws.id, role: "ADMIN" } });
    await tx.instanceSetting.update({ where: { id: 1 }, data: { installedAt: new Date(), installTokenHash: null } });
    await audit({ workspaceId: ws.id, actorId: user.id, action: "instance.setup", targetType: "workspace", targetId: ws.id }, tx);
    return { userId: user.id, slug: ws.slug };
  });
}
