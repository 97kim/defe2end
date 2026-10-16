import type { Prisma, PrismaClient } from "@defe2end/db";
import { getDb } from "./db";

/** Appends an audit record. `meta` must never contain secret values. */
export async function audit(
  entry: {
    workspaceId?: string | null;
    actorId?: string | null;
    action: string;
    targetType: string;
    targetId: string;
    meta?: Prisma.InputJsonValue;
  },
  db: Pick<PrismaClient, "auditLog"> | Prisma.TransactionClient = getDb(),
): Promise<void> {
  await db.auditLog.create({ data: entry });
}
