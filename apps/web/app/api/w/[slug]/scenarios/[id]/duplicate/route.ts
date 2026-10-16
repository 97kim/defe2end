import { route } from "../../../../../../../lib/api";
import { audit } from "../../../../../../../lib/audit";
import { getDb } from "../../../../../../../lib/db";
import { copyName } from "../../../../../../../lib/scenario-helpers";
import { scenarioSourceOf } from "../../../../../../../lib/mcp/source";
import { findScenario, scenarioInclude, toDetail } from "../../../../../../../lib/scenarios";

export const dynamic = "force-dynamic";

/** Copies steps, site and tags into a new, unarchived "Copy of …". */
export const POST = route<{ slug: string; id: string }>(
  { action: "scenario.write", resource: "scenario" },
  async (ctx) => {
    const { params, workspace, actor } = ctx;
    const source = await findScenario(workspace.id, params.id);
    const row = await getDb().$transaction(async (tx) => {
      const copy = await tx.scenario.create({
        data: {
          workspaceId: workspace.id,
          siteId: source.siteId,
          name: copyName(source.name),
          description: source.description,
          steps: source.steps ?? [],
          stepFormatVersion: source.stepFormatVersion,
          createdById: actor.userId,
          updatedById: actor.userId,
          source: scenarioSourceOf(ctx),
          tags: { create: source.tags.map((t) => ({ workspaceId: workspace.id, tagId: t.tag.id })) },
        },
      });
      await audit(
        { workspaceId: workspace.id, actorId: actor.userId, action: "scenario.duplicate", targetType: "scenario", targetId: copy.id, meta: { from: source.id } },
        tx,
      );
      return tx.scenario.findUniqueOrThrow({ where: { id: copy.id }, include: scenarioInclude });
    });
    return Response.json(toDetail(row), { status: 201 });
  },
);
