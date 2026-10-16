import { requestCancel } from "@defe2end/db";
import { ApiError, route } from "../../../../../../../lib/api";
import { audit } from "../../../../../../../lib/audit";
import { getDb } from "../../../../../../../lib/db";

export const dynamic = "force-dynamic";

/**
 * Queued → cancelled at once. Running → cancel requested; the run ends `cancelled` unless its own verdict
 * commits first. Finished → unchanged. Repeating answers the same.
 */
export const POST = route<{ slug: string; id: string }>({ action: "run.cancel", resource: "run" }, async ({ params, workspace, actor }) => {
  const outcome = await requestCancel(getDb(), workspace.id, params.id, actor.userId);
  if (!outcome) throw ApiError.notFound();
  await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "run.cancel", targetType: "run", targetId: params.id, meta: { status: outcome.status } });
  return Response.json({
    status: outcome.status,
    cancelRequested: outcome.cancelRequestedAt !== null && outcome.status === "running",
    cancelRequestedAt: outcome.cancelRequestedAt?.toISOString() ?? null,
    finishedAt: outcome.finishedAt?.toISOString() ?? null,
  });
});
