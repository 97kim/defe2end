import { readJson, route } from "../../../../../lib/api";
import { audit } from "../../../../../lib/audit";
import { listComparisons, listComparisonsQuerySchema, startComparison, startComparisonSchema } from "../../../../../lib/env-comparisons";

export const dynamic = "force-dynamic";

/** Newest first, 50 by default (≤ 100). Filters: `verdict`, `scenario` (name), `siteId`, `location`, `from`/`to` (dates). */
export const GET = route({ action: "run.read", resource: "run" }, async ({ request, workspace }) => {
  const query = listComparisonsQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await listComparisons(workspace.id, query));
});

/** Starts a comparison: 400 with `reasons` when a start check fails. */
export const POST = route({ action: "run.create", resource: "run" }, async ({ request, workspace, actor }) => {
  const body = await readJson(request, startComparisonSchema);
  const created = await startComparison(workspace.id, actor.userId!, body);
  await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "comparison.start", targetType: "comparison", targetId: created.comparisonId });
  return Response.json(created, { status: 201 });
});
