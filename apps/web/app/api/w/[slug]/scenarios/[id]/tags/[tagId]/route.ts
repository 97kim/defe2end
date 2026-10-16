import { ApiError, route } from "../../../../../../../../lib/api";
import { getDb } from "../../../../../../../../lib/db";
import { findScenario, scenarioInclude, toDetail } from "../../../../../../../../lib/scenarios";

export const dynamic = "force-dynamic";

/** Unassigns a tag. The tag itself stays in the workspace. */
export const DELETE = route<{ slug: string; id: string; tagId: string }>(
  { action: "scenario.write", resource: "scenario" },
  async ({ params, workspace }) => {
    const scenario = await findScenario(workspace.id, params.id);
    const tag = await getDb().tag.findFirst({ where: { id: params.tagId, workspaceId: workspace.id } });
    if (!tag) throw ApiError.notFound();
    await getDb().scenarioTag.deleteMany({ where: { scenarioId: scenario.id, tagId: tag.id, workspaceId: workspace.id } });
    const row = await getDb().scenario.findUniqueOrThrow({ where: { id: scenario.id }, include: scenarioInclude });
    return Response.json(toDetail(row));
  },
);
