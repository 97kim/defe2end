import { ApiError, route } from "../../../../../../../lib/api";
import { runEventsResponse } from "../../../../../../../lib/run-events";

export const dynamic = "force-dynamic";

/** Live progress (SSE): `snapshot` first, then `update`s once a second while something changed, `end` when finished. */
export const GET = route<{ slug: string; id: string }>({ action: "run.read", resource: "run" }, async ({ request, params, workspace, actor }) => {
  const response = await runEventsResponse({ request, workspace, userId: actor.userId, runId: params.id });
  if (!response) throw ApiError.notFound();
  return response;
});
