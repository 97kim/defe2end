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
