import { readJson, route } from "../../../../../lib/api";
import { audit } from "../../../../../lib/audit";
import { getDb } from "../../../../../lib/db";
import { environmentView, siteInputSchema, siteView, writeOrConflict } from "../../../../../lib/site-config";

export const dynamic = "force-dynamic";

/** Sites with their environments, by name. */
export const GET = route({ action: "workspace.read", resource: "site" }, async ({ workspace }) => {
  const sites = await getDb().site.findMany({
    where: { workspaceId: workspace.id },
    include: { environments: { orderBy: { name: "asc" } } },
    orderBy: { name: "asc" },
  });
  return Response.json({ sites: sites.map((s) => ({ ...siteView(s), environments: s.environments.map(environmentView) })) });
});

export const POST = route({ action: "config.write", resource: "site" }, async ({ request, workspace, actor }) => {
  const { name } = await readJson(request, siteInputSchema);
  const site = await writeOrConflict("A site with this name already exists", () =>
    getDb().$transaction(async (tx) => {
      const created = await tx.site.create({ data: { workspaceId: workspace.id, name } });
      await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "site.create", targetType: "site", targetId: created.id, meta: { name } }, tx);
      return created;
    }),
  );
  return Response.json(siteView(site), { status: 201 });
});
