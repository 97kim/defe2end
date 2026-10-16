import { STEP_FORMAT_VERSION, stepsSchema } from "@defe2end/shared";
import { z } from "zod";
import { readJson, route } from "../../../../../lib/api";
import { audit } from "../../../../../lib/audit";
import { getDb } from "../../../../../lib/db";
import { scenarioNameSchema, tagNameSchema } from "../../../../../lib/scenario-helpers";
import { scenarioSourceOf } from "../../../../../lib/mcp/source";
import { assertStepMasks, requireSite, scenarioInclude, setScenarioTags, toDetail, toSummary } from "../../../../../lib/scenarios";

export const dynamic = "force-dynamic";

/** All scenarios of the workspace, archived ones included (`archivedAt` set). */
export const GET = route({ action: "workspace.read", resource: "scenario" }, async ({ workspace }) => {
  const rows = await getDb().scenario.findMany({
    where: { workspaceId: workspace.id },
    include: scenarioInclude,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  return Response.json({ scenarios: rows.map(toSummary) });
});

const createSchema = z.strictObject({
  name: scenarioNameSchema,
  description: z.string().max(5000).default(""),
  siteId: z.string().min(1),
  steps: stepsSchema.default([]),
  tags: z.array(tagNameSchema).max(50).default([]),
});

export const POST = route({ action: "scenario.write", resource: "scenario" }, async (ctx) => {
  const { request, workspace, actor } = ctx;
  const body = await readJson(request, createSchema);
  await requireSite(workspace.id, body.siteId);
  assertStepMasks(body.steps);
  const row = await getDb().$transaction(async (tx) => {
    const created = await tx.scenario.create({
      data: {
        workspaceId: workspace.id,
        siteId: body.siteId,
        name: body.name,
        description: body.description,
        steps: body.steps,
        stepFormatVersion: STEP_FORMAT_VERSION,
        createdById: actor.userId,
        updatedById: actor.userId,
        source: scenarioSourceOf(ctx),
      },
    });
    await setScenarioTags(workspace.id, created.id, body.tags, tx);
    await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "scenario.create", targetType: "scenario", targetId: created.id }, tx);
    return tx.scenario.findUniqueOrThrow({ where: { id: created.id }, include: scenarioInclude });
  });
  return Response.json(toDetail(row), { status: 201 });
});
