import { ApiError, readJson, route } from "../../../../../../lib/api";
import { audit } from "../../../../../../lib/audit";
import { getDb } from "../../../../../../lib/db";
import { assertNoActiveRuns } from "../../../../../../lib/runs";
import { environmentView, isForeignKeyViolation, SITE_IN_USE, siteInputSchema, siteView, writeOrConflict } from "../../../../../../lib/site-config";

export const dynamic = "force-dynamic";

type Params = { slug: string; siteId: string };

async function findSite(workspaceId: string, siteId: string) {
  const site = await getDb().site.findFirst({ where: { id: siteId, workspaceId } });
  if (!site) throw ApiError.notFound();
  return site;
}

export const GET = route<Params>({ action: "workspace.read", resource: "site" }, async ({ params, workspace }) => {
  const site = await findSite(workspace.id, params.siteId);
  const environments = await getDb().environment.findMany({ where: { siteId: site.id, workspaceId: workspace.id }, orderBy: { name: "asc" } });
  return Response.json({ ...siteView(site), environments: environments.map(environmentView) });
});

export const PATCH = route<Params>({ action: "config.write", resource: "site" }, async ({ request, params, workspace, actor }) => {
  const site = await findSite(workspace.id, params.siteId);
  const { name } = await readJson(request, siteInputSchema);
  const updated = await writeOrConflict("A site with this name already exists", () =>
    getDb().$transaction(async (tx) => {
      const s = await tx.site.update({ where: { id: site.id }, data: { name } });
      await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "site.update", targetType: "site", targetId: site.id, meta: { from: site.name, to: name } }, tx);
      return s;
    }),
  );
  return Response.json(siteView(updated));
});

/**
 * Deletes the site with its environments and variables. Refused while scenarios (even archived) use it:
 * the count is only a fast path; the database's NO ACTION foreign key is what holds under a race.
 * Also refused while queued or running runs use one of its environments.
 */
export const DELETE = route<Params>({ action: "config.write", resource: "site" }, async ({ params, workspace, actor }) => {
  const site = await findSite(workspace.id, params.siteId);
  const inUse = new ApiError("conflict", SITE_IN_USE);
  if ((await getDb().scenario.count({ where: { siteId: site.id, workspaceId: workspace.id } })) > 0) throw inUse;
  try {
    await getDb().$transaction(async (tx) => {
      await assertNoActiveRuns(tx, workspace.id, { environment: { siteId: site.id } });
      await tx.site.delete({ where: { id: site.id } });
      await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "site.delete", targetType: "site", targetId: site.id, meta: { name: site.name } }, tx);
    });
  } catch (err) {
    if (isForeignKeyViolation(err)) throw inUse;
    throw err;
  }
  return new Response(null, { status: 204 });
});
