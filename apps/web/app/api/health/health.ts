import type { PrismaClient } from "@defe2end/db";

export interface Health {
  status: "ok" | "error";
  db: "ok" | "error";
  version: string;
  /** Set once the first administrator exists. */
  installedAt?: string | null;
}

/** Read-only: checks the database and reports when setup finished. */
export async function checkHealth(db: PrismaClient, version: string): Promise<Health> {
  try {
    const setting = await db.instanceSetting.findUnique({ where: { id: 1 }, select: { installedAt: true } });
    return { status: "ok", db: "ok", version, installedAt: setting?.installedAt?.toISOString() ?? null };
  } catch (err) {
    console.error("health check failed", err);
    return { status: "error", db: "error", version };
  }
}
