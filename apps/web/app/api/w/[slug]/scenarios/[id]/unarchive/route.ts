import { route } from "../../../../../../../lib/api";
import { audit } from "../../../../../../../lib/audit";
import { getDb } from "../../../../../../../lib/db";
import { findScenario, scenarioInclude, toDetail } from "../../../../../../../lib/scenarios";

export const dynamic = "force-dynamic";

/** Brings an archived scenario back. */
export const POST = route<{ slug: string; id: string }>(
  { action: "scenario.write", resource: "scenario" },
  async ({ params, workspace, actor }) => {
    const current = await findScenario(workspace.id, params.id);
    const row = await getDb().scenario.update({
      where: { id: current.id },
      data: { archivedAt: null, updatedById: actor.userId },
      include: scenarioInclude,
    });
    await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "scenario.unarchive", targetType: "scenario", targetId: current.id });
    return Response.json(toDetail(row));
  },
);
