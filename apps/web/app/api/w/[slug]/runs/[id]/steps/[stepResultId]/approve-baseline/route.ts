import { approveBaseline } from "@defe2end/db";
import { storageBaselineFiles } from "@defe2end/shared/server";
import { z } from "zod";
import { ApiError, readJson, route } from "../../../../../../../../../lib/api";
import { audit } from "../../../../../../../../../lib/audit";
import { getDb } from "../../../../../../../../../lib/db";
import { getStorage } from "../../../../../../../../../lib/storage";

export const dynamic = "force-dynamic";

/** `expectedVersion`: the baseline version the person saw (0 or null when there was none). */
const bodySchema = z.strictObject({ expectedVersion: z.number().int().min(0).nullable() });

/**
 * Approves this step result's screenshot as the new baseline of its key (stage 7 contract section 4). 409 when
 * the baseline moved on since `expectedVersion`; approving the same result again answers with its version.
 */
export const POST = route<{ slug: string; id: string; stepResultId: string }>({ action: "scenario.write", resource: "scenario" }, async ({ request, params, workspace, actor }) => {
  const body = await readJson(request, bodySchema);
  const result = await approveBaseline(getDb(), storageBaselineFiles(getStorage()), { workspaceId: workspace.id, runId: params.id, stepResultId: params.stepResultId, expectedVersion: body.expectedVersion, userId: actor.userId! });
  if (!result.ok) {
    if (result.status === 404) throw ApiError.notFound();
    throw new ApiError(result.status === 400 ? "invalid_request" : "conflict", result.message);
  }
  if (result.created) await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "baseline.approve", targetType: "run", targetId: params.id, meta: { stepResultId: params.stepResultId, version: result.version } });
  return Response.json({ versionId: result.versionId, version: result.version });
});
