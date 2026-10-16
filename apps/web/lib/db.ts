import { createDbClient, type PrismaClient } from "@defe2end/db";

const globalForDb = globalThis as { db?: PrismaClient };

/** One Prisma client per process (survives dev hot reloads). */
export function getDb(): PrismaClient {
  return (globalForDb.db ??= createDbClient());
}
