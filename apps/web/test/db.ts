import { describe } from "vitest";
import { getDb } from "../lib/db";

/** Use instead of `describe` for tests that need Postgres; skipped when TEST_DATABASE_URL is unset (never in CI). */
export const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** Empties every table. Call in `beforeAll`/`beforeEach` of integration test files. */
export async function resetDatabase(): Promise<void> {
  const db = getDb();
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}
