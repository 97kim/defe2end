import { route } from "../../../../../../../lib/api";
import { audit } from "../../../../../../../lib/audit";
import { cancel } from "../../../../../../../lib/env-comparisons";

export const dynamic = "force-dynamic";

/** Running comparisons only; an app comparison by its device's owner only (403). */
export const POST = route<{ slug: string; id: string }>({ action: "run.cancel", resource: "run" }, async ({ params, workspace, actor }) => {
  await cancel(workspace.id, params.id, actor.userId!);
  await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "comparison.cancel", targetType: "comparison", targetId: params.id });
  return Response.json({ status: "cancelled" });
});
