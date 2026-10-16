import { z } from "zod";
import { ApiError, readJson, route } from "../../../../../../lib/api";
import { audit } from "../../../../../../lib/audit";
import { getDb } from "../../../../../../lib/db";
import { buildExport, SCENARIO_TRANSFER_MAX } from "../../../../../../lib/scenario-helpers";

export const dynamic = "force-dynamic";

// Same cap as import, so every export file can be imported again.
const TOO_MANY = `Export at most ${SCENARIO_TRANSFER_MAX} scenarios at a time. Filter by tag or search to export fewer.`;

const exportSchema = z.strictObject({
  /** Omitted: every scenario that isn't archived. */
  ids: z.array(z.string().min(1)).min(1).max(SCENARIO_TRANSFER_MAX, TOO_MANY).optional(),
});

/** Contract section 7 export file. POST because it's a write-role action (and the id list can be long). */
export const POST = route({ action: "scenario.write", resource: "scenario" }, async ({ request, workspace, actor }) => {
  const body = await readJson(request, exportSchema);
  const ids = body.ids ? [...new Set(body.ids)] : undefined;
  const rows = await getDb().scenario.findMany({
    where: ids ? { workspaceId: workspace.id, id: { in: ids } } : { workspaceId: workspace.id, archivedAt: null },
    select: {
      name: true,
      description: true,
      steps: true,
      site: { select: { name: true } },
      tags: { select: { tag: { select: { name: true } } } },
    },
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    // One query, one more than the cap: rows created meanwhile can't slip past a separate count.
    take: SCENARIO_TRANSFER_MAX + 1,
  });
  if (rows.length > SCENARIO_TRANSFER_MAX) throw new ApiError("invalid_request", TOO_MANY);
  // Any id from another workspace (or unknown) fails the whole request, like every other id.
  if (ids && rows.length !== ids.length) throw ApiError.notFound();

  const file = buildExport(
    rows.map((r) => ({ name: r.name, description: r.description, siteName: r.site.name, tagNames: r.tags.map((t) => t.tag.name), steps: r.steps })),
  );
  await audit({
    workspaceId: workspace.id,
    actorId: actor.userId,
    action: "scenario.export",
    targetType: "workspace",
    targetId: workspace.id,
    meta: { count: rows.length },
  });
  const date = new Date().toISOString().slice(0, 10);
  return Response.json(file, {
    headers: { "content-disposition": `attachment; filename="defe2end-scenarios-${workspace.slug}-${date}.json"` },
  });
});
