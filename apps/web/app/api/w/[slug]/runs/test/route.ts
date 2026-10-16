import { readJson, route } from "../../../../../../lib/api";
import { createTestRun, createTestRunSchema, getRunDetail, readIdempotencyKey } from "../../../../../../lib/runs";

export const dynamic = "force-dynamic";

/**
 * Pre-save test run of the editor's steps (`trigger: test`, no scenario). Steps are validated like saved ones.
 * The result is kept 24 hours after the run ends, then deleted with its files.
 */
export const POST = route({ action: "run.create", resource: "run" }, async ({ request, workspace, actor }) => {
  const idempotencyKey = readIdempotencyKey(request);
  const body = await readJson(request, createTestRunSchema);
  const { runId, created } = await createTestRun({ workspaceId: workspace.id, actorId: actor.userId, request: body, idempotencyKey });
  return Response.json(await getRunDetail(workspace, runId), { status: created ? 201 : 200 });
});
