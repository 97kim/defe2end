import { ApiError, readJson, route } from "../../../../../../lib/api";
import { audit } from "../../../../../../lib/audit";
import { getDb } from "../../../../../../lib/db";
import { assertNoActiveRuns } from "../../../../../../lib/runs";
import { environmentUpdateSchema, environmentView, writeOrConflict } from "../../../../../../lib/site-config";

export const dynamic = "force-dynamic";

type Params = { slug: string; environmentId: string };

async function findEnvironment(workspaceId: string, environmentId: string) {
  const env = await getDb().environment.findFirst({ where: { id: environmentId, workspaceId } });
  if (!env) throw ApiError.notFound();
  return env;
}

export const GET = route<Params>({ action: "workspace.read", resource: "environment" }, async ({ params, workspace }) => {
  return Response.json(environmentView(await findEnvironment(workspace.id, params.environmentId)));
});

export const PATCH = route<Params>({ action: "config.write", resource: "environment" }, async ({ request, params, workspace, actor }) => {
  const env = await findEnvironment(workspace.id, params.environmentId);
  const input = await readJson(request, environmentUpdateSchema);
  const updated = await writeOrConflict("This site already has an environment with this name", () =>
    getDb().$transaction(async (tx) => {
      const e = await tx.environment.update({ where: { id: env.id }, data: input });
      await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "environment.update", targetType: "environment", targetId: env.id, meta: input }, tx);
      return e;
    }),
  );
  return Response.json(environmentView(updated));
});

/** Deletes the environment and its variables; refused while queued or running runs use it. */
export const DELETE = route<Params>({ action: "config.write", resource: "environment" }, async ({ params, workspace, actor }) => {
  const env = await findEnvironment(workspace.id, params.environmentId);
  await getDb().$transaction(async (tx) => {
    await assertNoActiveRuns(tx, workspace.id, { environmentId: env.id });
    await tx.environment.delete({ where: { id: env.id } });
    await audit(
      { workspaceId: workspace.id, actorId: actor.userId, action: "environment.delete", targetType: "environment", targetId: env.id, meta: { siteId: env.siteId, name: env.name } },
      tx,
    );
  });
  return new Response(null, { status: 204 });
});
