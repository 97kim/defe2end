import { z } from "zod";
import { ApiError, readJson, route } from "../../../../../../../lib/api";
import { getDb } from "../../../../../../../lib/db";
import { tagNameSchema } from "../../../../../../../lib/scenario-helpers";
import { findScenario, scenarioInclude, toDetail, upsertTag } from "../../../../../../../lib/scenarios";

export const dynamic = "force-dynamic";

const assignSchema = z.union([z.strictObject({ tagId: z.string().min(1) }), z.strictObject({ name: tagNameSchema })]);

/** Assigns an existing tag (`tagId`) or creates one on the fly (`name`). Doesn't change the scenario's `updatedAt`. */
export const POST = route<{ slug: string; id: string }>(
  { action: "scenario.write", resource: "scenario" },
  async ({ request, params, workspace }) => {
    const body = await readJson(request, assignSchema);
    const scenario = await findScenario(workspace.id, params.id);
    const tag =
      "tagId" in body
        ? await getDb().tag.findFirst({ where: { id: body.tagId, workspaceId: workspace.id } })
        : await upsertTag(workspace.id, body.name);
    if (!tag) throw ApiError.notFound();
    await getDb().scenarioTag.upsert({
      where: { scenarioId_tagId: { scenarioId: scenario.id, tagId: tag.id } },
      create: { workspaceId: workspace.id, scenarioId: scenario.id, tagId: tag.id },
      update: {},
    });
    const row = await getDb().scenario.findUniqueOrThrow({ where: { id: scenario.id }, include: scenarioInclude });
    return Response.json(toDetail(row));
  },
);
