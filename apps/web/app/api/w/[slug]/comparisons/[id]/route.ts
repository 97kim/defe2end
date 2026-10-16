import { route } from "../../../../../../lib/api";
import { getComparisonDetail } from "../../../../../../lib/env-comparisons";

export const dynamic = "force-dynamic";

export const GET = route<{ slug: string; id: string }>({ action: "run.read", resource: "run" }, async ({ params, workspace }) => {
  return Response.json(await getComparisonDetail(workspace.id, params.id));
});
