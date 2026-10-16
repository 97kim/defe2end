import { Prisma } from "@defe2end/db";
import { randomBytes } from "node:crypto";
import { lockAndRevalidateActor } from "./accounts/admin-lock";
import { audit } from "./audit";
import { getDb } from "./db";
import { slugify } from "./slug";

/**
 * Creates a workspace with `creatorId` as its ADMIN. The slug comes from the name; on a clash a
 * short random suffix is added (slugs are public in URLs, so no sequential numbering is needed).
 */
export async function createWorkspaceFor(creatorId: string, name: string): Promise<{ id: string; name: string; slug: string }> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base.slice(0, 41)}-${randomBytes(3).toString("hex")}`;
    try {
      return await getDb().$transaction(async (tx) => {
        // The creator must still be an active instance admin once the lock is held.
        await lockAndRevalidateActor(tx, creatorId, { kind: "instanceAdmin" });
        const ws = await tx.workspace.create({ data: { name, slug } });
        await tx.membership.create({ data: { userId: creatorId, workspaceId: ws.id, role: "ADMIN" } });
        await audit({ workspaceId: ws.id, actorId: creatorId, action: "workspace.create", targetType: "workspace", targetId: ws.id, meta: { name, slug } }, tx);
        return { id: ws.id, name: ws.name, slug: ws.slug };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
  }
  throw new Error("Could not find a free workspace slug");
}
