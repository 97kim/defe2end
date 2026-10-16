import { readJson, route } from "../../../../../lib/api";
import { createGroupRun, createGroupSchema, readIdempotencyKey } from "../../../../../lib/runs";

export const dynamic = "force-dynamic";

/**
 * Queues a group: one environment, scenarios of its site, all children at once (or none, e.g. over the queue
 * limit). `Idempotency-Key`: same key and body → the same group (200), different body → 409.
 */
export const POST = route({ action: "run.create", resource: "run" }, async ({ request, workspace, actor }) => {
  const idempotencyKey = readIdempotencyKey(request);
  const body = await readJson(request, createGroupSchema);
  const { groupRunId, runIds, created } = await createGroupRun({ workspaceId: workspace.id, actorId: actor.userId, request: body, idempotencyKey });
  return Response.json({ id: groupRunId, runIds }, { status: created ? 201 : 200 });
});
