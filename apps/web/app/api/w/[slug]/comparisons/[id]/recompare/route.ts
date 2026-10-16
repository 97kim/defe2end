import { readJson, route } from "../../../../../../../lib/api";
import { audit } from "../../../../../../../lib/audit";
import { recompare, recompareSchema } from "../../../../../../../lib/env-comparisons";

export const dynamic = "force-dynamic";

/** Judges the captured screens again (finished comparisons only), optionally with a new tolerance. */
export const POST = route<{ slug: string; id: string }>({ action: "run.create", resource: "run" }, async ({ request, params, workspace, actor }) => {
  const body = await readJson(request, recompareSchema);
  await recompare(workspace.id, params.id, body.tolerance);
  await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "comparison.recompare", targetType: "comparison", targetId: params.id });
  return Response.json({ status: "comparing" }, { status: 202 });
});
