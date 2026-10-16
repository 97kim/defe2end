import { ApiError, readJson, route } from "../../../../../../../lib/api";
import { audit } from "../../../../../../../lib/audit";
import { getDb } from "../../../../../../../lib/db";
import { environmentCreateSchema, environmentView, writeOrConflict } from "../../../../../../../lib/site-config";

export const dynamic = "force-dynamic";

type Params = { slug: string; siteId: string };

async function findSite(workspaceId: string, siteId: string) {
  const site = await getDb().site.findFirst({ where: { id: siteId, workspaceId } });
  if (!site) throw ApiError.notFound();
  return site;
}

export const GET = route<Params>({ action: "workspace.read", resource: "environment" }, async ({ params, workspace }) => {
  const site = await findSite(workspace.id, params.siteId);
  const environments = await getDb().environment.findMany({ where: { siteId: site.id, workspaceId: workspace.id }, orderBy: { name: "asc" } });
  return Response.json({ environments: environments.map(environmentView) });
});

export const POST = route<Params>({ action: "config.write", resource: "environment" }, async ({ request, params, workspace, actor }) => {
  const site = await findSite(workspace.id, params.siteId);
  const { name, baseUrl, useAuthSession } = await readJson(request, environmentCreateSchema);
  const env = await writeOrConflict("This site already has an environment with this name", () =>
    getDb().$transaction(async (tx) => {
      const created = await tx.environment.create({ data: { workspaceId: workspace.id, siteId: site.id, name, baseUrl, useAuthSession } });
      await audit(
        { workspaceId: workspace.id, actorId: actor.userId, action: "environment.create", targetType: "environment", targetId: created.id, meta: { siteId: site.id, name, baseUrl } },
        tx,
      );
      return created;
    }),
  );
  return Response.json(environmentView(env), { status: 201 });
});
