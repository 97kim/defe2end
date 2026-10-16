import { stepsSchema } from "@defe2end/shared";
import { z } from "zod";
import { ApiError, readJson, route } from "../../../../../../lib/api";
import { audit } from "../../../../../../lib/audit";
import { getDb } from "../../../../../../lib/db";
import { scenarioNameSchema } from "../../../../../../lib/scenario-helpers";
import { scenarioSourceOf } from "../../../../../../lib/mcp/source";
import { assertStepMasks, findScenario, requireSite, RETRY_SETTING_STORED, scenarioInclude, toDetail } from "../../../../../../lib/scenarios";

export const dynamic = "force-dynamic";

type Params = { slug: string; id: string };

export const GET = route<Params>({ action: "workspace.read", resource: "scenario" }, async ({ params, workspace }) => {
  return Response.json(toDetail(await findScenario(workspace.id, params.id)));
});

const updateSchema = z.strictObject({
  /** The `updatedAt` the client last saw; a newer save in between answers 409. */
  updatedAt: z.iso.datetime(),
  name: scenarioNameSchema.optional(),
  description: z.string().max(5000).optional(),
  siteId: z.string().min(1).optional(),
  steps: stepsSchema.optional(),
  /** Retry the whole run once after a failure (spec 4.3). */
  retryOnFailure: z.boolean().optional(),
  /** Site selectors and automatic detection (stage 7 section 5). */
  maskingEnabled: z.boolean().optional(),
});

export const PATCH = route<Params>({ action: "scenario.write", resource: "scenario" }, async (ctx) => {
  const { request, params, workspace, actor } = ctx;
  const body = await readJson(request, updateSchema);
  const current = await findScenario(workspace.id, params.id);
  if (current.archivedAt) throw new ApiError("conflict", "Archived scenarios can't be edited. Unarchive it first.");
  if (body.siteId) await requireSite(workspace.id, body.siteId);
  if (body.steps) assertStepMasks(body.steps);
  if (body.retryOnFailure !== undefined && !RETRY_SETTING_STORED) throw new ApiError("invalid_request", "This server can't store the retry setting yet");

  // Conditional update: only succeeds if nobody saved since the client loaded it.
  const { count } = await getDb().scenario.updateMany({
    where: { id: current.id, workspaceId: workspace.id, updatedAt: new Date(body.updatedAt), archivedAt: null },
    data: {
      name: body.name,
      description: body.description,
      siteId: body.siteId,
      steps: body.steps,
      ...(body.retryOnFailure !== undefined ? ({ retryOnFailure: body.retryOnFailure } as object) : {}),
      maskingEnabled: body.maskingEnabled,
      updatedById: actor.userId,
      source: scenarioSourceOf(ctx),
      updatedAt: new Date(),
    },
  });
  if (count === 0) throw new ApiError("conflict", "This scenario was changed by someone else. Reload to see the latest version.");
  await audit({
    workspaceId: workspace.id,
    actorId: actor.userId,
    action: "scenario.update",
    targetType: "scenario",
    targetId: current.id,
    meta: { fields: Object.keys(body).filter((k) => k !== "updatedAt") },
  });
  const row = await getDb().scenario.findUniqueOrThrow({ where: { id: current.id }, include: scenarioInclude });
  return Response.json(toDetail(row));
});
