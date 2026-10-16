import { lockVariableDefinition } from "@defe2end/db";
import { ApiError, readJson, route } from "../../../../../../../lib/api";
import { audit } from "../../../../../../../lib/audit";
import { getDb } from "../../../../../../../lib/db";
import { encrypt } from "../../../../../../../lib/encryption";
import { personalValueSchema, variableView, writeOrConflict } from "../../../../../../../lib/site-config";

export const dynamic = "force-dynamic";

type Params = { slug: string; variableId: string };

/** A personal variable of this workspace; another workspace's or missing → 404, a shared one → 409. */
async function findPersonal(workspaceId: string, variableId: string) {
  const variable = await getDb().variable.findFirst({ where: { id: variableId, workspaceId } });
  if (!variable) throw ApiError.notFound();
  if (variable.scope !== "personal") throw new ApiError("conflict", "This variable is shared; it has no personal values");
  return variable;
}

/** Sets the caller's own value (variables contract section 4). Secret variables keep it encrypted. */
export const PUT = route<Params>({ action: "variable.personal.write", resource: "variable" }, async ({ request, params, workspace, actor }) => {
  await findPersonal(workspace.id, params.variableId);
  const { value } = await readJson(request, personalValueSchema);
  const { variable, mine } = await writeOrConflict(
    "Couldn't save the value",
    () =>
      getDb().$transaction(async (tx) => {
        // Under the variable's row lock: a concurrent scope or secret-flag change can't leave a plain value
        // on a secret, or a value on a variable that no longer has personal values.
        if (!(await lockVariableDefinition(tx, workspace.id, params.variableId))) throw ApiError.notFound();
        const variable = await tx.variable.findUniqueOrThrow({ where: { id: params.variableId } });
        if (variable.scope !== "personal") throw new ApiError("conflict", "This variable is shared; it has no personal values");
        if (variable.isSecret && value.length === 0) throw new ApiError("invalid_request", "A secret needs a value");
        const data = variable.isSecret ? { value: null, valueEncrypted: encrypt(value) } : { value, valueEncrypted: null };
        const row = await tx.personalVariableValue.upsert({
          where: { variableId_userId: { variableId: variable.id, userId: actor.userId } },
          create: { variableId: variable.id, userId: actor.userId, ...data },
          update: data,
        });
        // Never the value.
        await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "variable.personal.set", targetType: "variable", targetId: variable.id, meta: { key: variable.key } }, tx);
        return { variable, mine: row };
      }),
    [value],
  );
  return Response.json(variableView(variable, mine));
});

/** Removes the caller's own value; runs that use the variable are refused until they set one again. */
export const DELETE = route<Params>({ action: "variable.personal.write", resource: "variable" }, async ({ params, workspace, actor }) => {
  const variable = await findPersonal(workspace.id, params.variableId);
  await getDb().$transaction(async (tx) => {
    await tx.personalVariableValue.deleteMany({ where: { variableId: variable.id, userId: actor.userId } });
    await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "variable.personal.delete", targetType: "variable", targetId: variable.id, meta: { key: variable.key } }, tx);
  });
  return new Response(null, { status: 204 });
});
