import { ApiError, route } from "../../../../../../lib/api";
import { comparisonChoices } from "../../../../../../lib/env-comparisons";

export const dynamic = "force-dynamic";

/** The start form's choices for `?scenarioId=`. */
export const GET = route({ action: "run.read", resource: "run" }, async ({ request, workspace, actor }) => {
  const scenarioId = new URL(request.url).searchParams.get("scenarioId");
  if (!scenarioId) throw new ApiError("invalid_request", "scenarioId is required");
  return Response.json(await comparisonChoices(workspace.id, actor.userId!, scenarioId));
});
