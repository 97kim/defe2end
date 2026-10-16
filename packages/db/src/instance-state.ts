import { KNOWN_MIGRATIONS } from "./generated/migrations.js";
import type { PrismaClient } from "./generated/prisma/client.js";

/** Connections from web and worker carry this `application_name`, so `backup` can tell the app is still up. */
export const APP_CONNECTION_NAME = "defe2end-app";

export class RestoreInProgressError extends Error {
  constructor() {
    super(
      "A restore into this database started and did not finish. Start over on an empty database and storage " +
        "(see docs/backup-restore.md); the instance won't run half restored.",
    );
  }
}

/** Throws while `restore` is running or after it stopped half way. Called on web and worker start. */
export async function assertNotRestoring(db: PrismaClient): Promise<void> {
  const setting = await db.instanceSetting.findUnique({ where: { id: 1 }, select: { restoreInProgressAt: true } });
  if (setting?.restoreInProgressAt) throw new RestoreInProgressError();
}

/** True after a restore until `resume-automation`: no schedules, notification deliveries or run claims. */
export async function isAutomationPaused(db: PrismaClient): Promise<boolean> {
  const setting = await db.instanceSetting.findUnique({ where: { id: 1 }, select: { automationPausedAt: true } });
  return Boolean(setting?.automationPausedAt);
}

/** What differs between the migrations applied to the database and the ones this build knows. */
export function compareMigrations(applied: readonly string[], known: readonly string[] = KNOWN_MIGRATIONS) {
  return { unknown: applied.filter((n) => !known.includes(n)), missing: known.filter((n) => !applied.includes(n)) };
}

export class MigrationMismatchError extends Error {
  constructor(readonly unknown: string[], readonly missing: string[]) {
    const parts = [];
    if (missing.length) parts.push(`not applied yet: ${missing.join(", ")}`);
    if (unknown.length) parts.push(`applied but unknown to this version (a newer version's migrations): ${unknown.join(", ")}`);
    super(
      `The database migrations don't match this version (${parts.join("; ")}). ` +
        (unknown.length
          ? "Run the images of the version the database was migrated with."
          : "Run this version's migrate first: docker compose run --rm migrate"),
    );
  }
}

/** Web and worker start only when the applied migrations are exactly the ones this build knows. */
export async function assertMigrationsMatch(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const { unknown, missing } = compareMigrations(rows.map((r) => r.migration_name));
  if (unknown.length || missing.length) throw new MigrationMismatchError(unknown, missing);
}
