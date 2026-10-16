import { STEP_FORMAT_VERSION } from "@defe2end/shared";
import { z } from "zod";
import { readJson, route } from "../../../../../../lib/api";
import { audit } from "../../../../../../lib/audit";
import { getDb } from "../../../../../../lib/db";
import { importFileSchema, planImport } from "../../../../../../lib/scenario-helpers";
import { setScenarioTags } from "../../../../../../lib/scenarios";

export const dynamic = "force-dynamic";

const importSchema = z.strictObject({
  file: importFileSchema,
  /** Preview only: validate and report, write nothing. */
  dryRun: z.boolean().default(false),
});

/**
 * Imports a section 7 export file. Each scenario is checked on its own: valid ones are created,
 * invalid ones and ones whose site doesn't exist here are skipped with a reason. Sites are never created.
 */
export const POST = route({ action: "scenario.write", resource: "scenario" }, async ({ request, workspace, actor }) => {
  const body = await readJson(request, importSchema);
  const sites = await getDb().site.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true } });
  const plan = planImport(body.file.scenarios, new Map(sites.map((s) => [s.name, s.id])));
  const summary = {
    dryRun: body.dryRun,
    total: body.file.scenarios.length,
    created: plan.create.map((s) => ({ name: s.name, site: s.site, stepCount: s.steps.length })),
    skipped: plan.skipped,
  };
  if (body.dryRun || plan.create.length === 0) return Response.json(summary);

  await getDb().$transaction(
    async (tx) => {
      for (const s of plan.create) {
        const created = await tx.scenario.create({
          data: {
            workspaceId: workspace.id,
            siteId: s.siteId,
            name: s.name,
            description: s.description,
            steps: s.steps,
            stepFormatVersion: STEP_FORMAT_VERSION,
            createdById: actor.userId,
            updatedById: actor.userId,
          },
        });
        await setScenarioTags(workspace.id, created.id, s.tags, tx);
      }
      await audit(
        {
          workspaceId: workspace.id,
          actorId: actor.userId,
          action: "scenario.import",
          targetType: "workspace",
          targetId: workspace.id,
          meta: { created: plan.create.length, skipped: plan.skipped.length },
        },
        tx,
      );
    },
    { timeout: 60_000 },
  );
  return Response.json(summary, { status: 201 });
});
