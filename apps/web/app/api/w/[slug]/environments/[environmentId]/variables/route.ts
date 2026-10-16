import { ApiError, readJson, route } from "../../../../../../../lib/api";
import { audit } from "../../../../../../../lib/audit";
import { getDb } from "../../../../../../../lib/db";
import { encrypt } from "../../../../../../../lib/encryption";
import { ownPersonalValue, variableCreateSchema, variableView, writeOrConflict } from "../../../../../../../lib/site-config";

export const dynamic = "force-dynamic";

type Params = { slug: string; environmentId: string };

async function findEnvironment(workspaceId: string, environmentId: string) {
  const env = await getDb().environment.findFirst({ where: { id: environmentId, workspaceId } });
  if (!env) throw ApiError.notFound();
  return env;
}

/** Variables of one environment. Secret values are never returned. */
export const GET = route<Params>({ action: "workspace.read", resource: "variable" }, async ({ params, workspace, actor }) => {
  const env = await findEnvironment(workspace.id, params.environmentId);
  const variables = await getDb().variable.findMany({ where: { environmentId: env.id, workspaceId: workspace.id }, include: ownPersonalValue(actor.userId), orderBy: { key: "asc" } });
  return Response.json({ variables: variables.map((v) => variableView(v, v.personalValues[0])) });
});

export const POST = route<Params>({ action: "config.write", resource: "variable" }, async ({ request, params, workspace, actor }) => {
  const env = await findEnvironment(workspace.id, params.environmentId);
  const { key, value, isSecret, scope } = await readJson(request, variableCreateSchema);
  const shared = scope === "shared";
  const variable = await writeOrConflict(
    "This environment already has a variable with this key",
    () =>
      getDb().$transaction(async (tx) => {
        const created = await tx.variable.create({
          data: {
            workspaceId: workspace.id,
            environmentId: env.id,
            key,
            isSecret,
            scope,
            value: shared && !isSecret ? value : null,
            valueEncrypted: shared && isSecret ? encrypt(value) : null,
          },
        });
        // Never the value, secret or not: audit entries outlive the variable.
        await audit(
          { workspaceId: workspace.id, actorId: actor.userId, action: "variable.create", targetType: "variable", targetId: created.id, meta: { environmentId: env.id, key, isSecret, scope } },
          tx,
        );
        return created;
      }),
    isSecret && value ? [value] : [],
  );
  return Response.json(variableView(variable), { status: 201 });
});
