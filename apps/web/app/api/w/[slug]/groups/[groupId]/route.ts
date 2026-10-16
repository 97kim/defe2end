import { ApiError, route } from "../../../../../../lib/api";
import { getGroupRun } from "../../../../../../lib/run-read";

export const dynamic = "force-dynamic";

/** A group run and its children in order. */
export const GET = route<{ slug: string; groupId: string }>({ action: "run.read", resource: "run" }, async ({ params, workspace }) => {
  const group = await getGroupRun(workspace.id, params.groupId);
  if (!group) throw ApiError.notFound();
  return Response.json(group);
});
