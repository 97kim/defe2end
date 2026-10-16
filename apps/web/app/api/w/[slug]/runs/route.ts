import { readJson, route } from "../../../../../lib/api";
import { listRuns, readListQuery } from "../../../../../lib/run-read";
import { createRun, createRunSchema, getRunDetail, readIdempotencyKey } from "../../../../../lib/runs";

export const dynamic = "force-dynamic";

/** Newest first. Filters: `scenarioId`, `environmentId`, `status`, `trigger`; pages: `page` (from 1), `limit` (≤ 100). */
export const GET = route({ action: "run.read", resource: "run" }, async ({ request, workspace }) => {
  const query = readListQuery(new URL(request.url).searchParams);
  return Response.json(await listRuns(workspace.id, query));
});

/** Queues a run. `Idempotency-Key` makes retries safe: same key and body → the same run (200), different body → 409. */
export const POST = route({ action: "run.create", resource: "run" }, async ({ request, workspace, actor }) => {
  const idempotencyKey = readIdempotencyKey(request);
  const body = await readJson(request, createRunSchema);
  const { runId, created } = await createRun({ workspaceId: workspace.id, actorId: actor.userId, trigger: "manual", request: body, idempotencyKey });
  return Response.json(await getRunDetail(workspace, runId), { status: created ? 201 : 200 });
});
