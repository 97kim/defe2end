import { stopAllRuns } from "@defe2end/db";
import { route } from "../../../../../../lib/api";
import { audit } from "../../../../../../lib/audit";
import { getDb } from "../../../../../../lib/db";

export const dynamic = "force-dynamic";

/**
 * Stops the runs queued or running when this request is committed: queued ones are cancelled at once,
 * running ones get a cancel request. Runs created afterwards are not affected.
 */
export const POST = route({ action: "run.stopAll", resource: "run" }, async ({ workspace, actor }) => {
  const result = await stopAllRuns(getDb(), workspace.id, actor.userId);
  await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "run.stopAll", targetType: "workspace", targetId: workspace.id, meta: result });
  return Response.json(result);
});
