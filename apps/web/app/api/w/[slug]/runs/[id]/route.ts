import { route } from "../../../../../../lib/api";
import { getRunDetail } from "../../../../../../lib/runs";

export const dynamic = "force-dynamic";

export const GET = route<{ slug: string; id: string }>({ action: "run.read", resource: "run" }, async ({ params, workspace }) => {
  return Response.json(await getRunDetail(workspace, params.id));
});
