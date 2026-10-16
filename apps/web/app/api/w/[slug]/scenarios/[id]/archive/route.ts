import { route } from "../../../../../../../lib/api";
import { audit } from "../../../../../../../lib/audit";
import { getDb } from "../../../../../../../lib/db";
import { findScenario, scenarioInclude, toDetail } from "../../../../../../../lib/scenarios";

export const dynamic = "force-dynamic";

/** Hides the scenario from the default list; it stays readable and can be unarchived. */
export const POST = route<{ slug: string; id: string }>(
  { action: "scenario.write", resource: "scenario" },
  async ({ params, workspace, actor }) => {
    const current = await findScenario(workspace.id, params.id);
    const row = await getDb().scenario.update({
      where: { id: current.id },
      data: { archivedAt: new Date(), updatedById: actor.userId },
      include: scenarioInclude,
    });
    await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "scenario.archive", targetType: "scenario", targetId: current.id });
    return Response.json(toDetail(row));
  },
);
