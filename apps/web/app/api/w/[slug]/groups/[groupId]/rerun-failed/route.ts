import { route } from "../../../../../../../lib/api";
import { readIdempotencyKey, rerunFailed } from "../../../../../../../lib/runs";

export const dynamic = "force-dynamic";

/** A new group of the finished group's failed, error and timed-out runs. The old group stays as it was. */
export const POST = route<{ slug: string; groupId: string }>({ action: "run.create", resource: "run" }, async ({ request, params, workspace, actor }) => {
  const idempotencyKey = readIdempotencyKey(request);
  const { groupRunId, runIds, created } = await rerunFailed({ workspaceId: workspace.id, actorId: actor.userId, groupRunId: params.groupId, idempotencyKey });
  return Response.json({ id: groupRunId, runIds }, { status: created ? 201 : 200 });
});
