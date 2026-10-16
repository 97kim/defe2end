// Baseline version cleanup (stage 7 contract section 1, baseline storage).
import { BASELINE_KEEP_VERSIONS } from "@defe2end/shared";
import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * Deletes baseline versions that are outside the newest `BASELINE_KEEP_VERSIONS` of their baseline, that no
 * step result judged against and that no run has pinned; returns their storage keys for the caller to delete
 * (rows first, like test run cleanup; a crash in between leaves files the orphan sweep removes). The current
 * version is always among the newest, and a run pins only current versions, so a version this picks can't
 * gain a pin; the row lock makes a racing pin insert wait and then fail rather than point at a deleted row.
 * Runs must write their step results before dropping their pins, so a used version is never unreferenced.
 */
export async function deletePrunableBaselineVersions(db: PrismaClient, batch = 100): Promise<{ versionIds: string[]; storageKeys: string[] }> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; storageKey: string }[]>`
      SELECT v.id, v."storageKey" FROM "VisualBaselineVersion" v
      WHERE v.id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY "baselineId" ORDER BY version DESC) AS rank FROM "VisualBaselineVersion"
        ) ranked WHERE rank > ${BASELINE_KEEP_VERSIONS}::int)
        AND NOT EXISTS (SELECT 1 FROM "StepResult" s WHERE s."visualBaselineVersionId" = v.id)
        AND NOT EXISTS (SELECT 1 FROM "RunBaselinePin" p WHERE p."versionId" = v.id)
      ORDER BY v."createdAt" LIMIT ${batch}::int
      FOR UPDATE OF v SKIP LOCKED`;
    const versionIds = rows.map((r) => r.id);
    if (versionIds.length > 0) await tx.visualBaselineVersion.deleteMany({ where: { id: { in: versionIds } } });
    return { versionIds, storageKeys: rows.map((r) => r.storageKey) };
  });
}
