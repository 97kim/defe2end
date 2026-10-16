import { dropUnattendedValues, lockVariableDefinition } from "@defe2end/db";
import { ApiError, readJson, route } from "../../../../../../lib/api";
import { audit } from "../../../../../../lib/audit";
import { getDb } from "../../../../../../lib/db";
import { encrypt } from "../../../../../../lib/encryption";
import { ownPersonalValue, variableUpdateSchema, variableView, writeOrConflict } from "../../../../../../lib/site-config";

export const dynamic = "force-dynamic";

type Params = { slug: string; variableId: string };

async function findVariable(workspaceId: string, variableId: string) {
  const variable = await getDb().variable.findFirst({ where: { id: variableId, workspaceId } });
  if (!variable) throw ApiError.notFound();
  return variable;
}

export const GET = route<Params>({ action: "workspace.read", resource: "variable" }, async ({ params, workspace, actor }) => {
  const variable = await getDb().variable.findFirst({ where: { id: params.variableId, workspaceId: workspace.id }, include: ownPersonalValue(actor.userId) });
  if (!variable) throw ApiError.notFound();
  return Response.json(variableView(variable, variable.personalValues[0]));
});

/**
 * Secrets are write-only: omit `value` to keep the stored one. Turning a secret into a plain
 * variable needs a new value (the old one is never revealed); a plain value turned secret is encrypted.
 * Scope (variables contract section 1): shared → personal drops the shared value; personal → shared drops
 * every personal value. Changing the secret flag of a personal variable drops every personal value too.
 */
export const PATCH = route<Params>({ action: "config.write", resource: "variable" }, async ({ request, params, workspace, actor }) => {
  await findVariable(workspace.id, params.variableId);
  const input = await readJson(request, variableUpdateSchema);
  // The only plaintext in the query; keep it out of any error message.
  const secrets = input.isSecret !== false && input.value ? [input.value] : [];
  const updated = await writeOrConflict(
    "This environment already has a variable with this key",
    () =>
      getDb().$transaction(async (tx) => {
        // Decide from the definition under the row lock: concurrent changes and own-value writers (person,
        // schedule, bot) serialise on it, so no value is kept or dropped by an outdated definition.
        if (!(await lockVariableDefinition(tx, workspace.id, params.variableId))) throw ApiError.notFound();
        const current = await tx.variable.findUniqueOrThrow({ where: { id: params.variableId } });
        const { isSecret, scope, value, valueEncrypted, dropPersonal } = planUpdate(current, input);
        const v = await tx.variable.update({ where: { id: current.id }, data: { key: input.key ?? current.key, isSecret, scope, value, valueEncrypted } });
        if (dropPersonal) {
          await tx.personalVariableValue.deleteMany({ where: { variableId: current.id } });
          // Schedules' and bot tokens' own values follow the same rule (stage 5 contract section 2).
          await dropUnattendedValues(tx, current.id);
        }
        await audit(
          {
            workspaceId: workspace.id,
            actorId: actor.userId,
            action: "variable.update",
            targetType: "variable",
            targetId: current.id,
            meta: { key: v.key, previousKey: current.key, isSecret, wasSecret: current.isSecret, scope, previousScope: current.scope, valueChanged: input.value !== undefined, personalValuesDropped: dropPersonal },
          },
          tx,
        );
        return v;
      }),
    secrets,
  );
  const mine = updated.scope === "personal" ? await getDb().personalVariableValue.findUnique({ where: { variableId_userId: { variableId: updated.id, userId: actor.userId } } }) : null;
  return Response.json(variableView(updated, mine));
});

type VariableRow = { isSecret: boolean; scope: "shared" | "personal"; value: string | null; valueEncrypted: string | null };

/** The new definition and whether own values go, from the current (locked) row and the request. */
function planUpdate(current: VariableRow, input: { isSecret?: boolean; scope?: "shared" | "personal"; value?: string }) {
  const isSecret = input.isSecret ?? current.isSecret;
  const scope = input.scope ?? current.scope;
  let value: string | null = null;
  let valueEncrypted: string | null = null;
  let dropPersonal = false;
  if (scope === "personal") {
    if (input.value !== undefined) throw new ApiError("invalid_request", "A personal variable has no shared value; each person sets their own");
    dropPersonal = current.scope === "personal" && isSecret !== current.isSecret;
  } else if (current.scope === "personal") {
    // personal → shared: the shared value starts from the request (a secret without one waits for a value).
    dropPersonal = true;
    if (isSecret) valueEncrypted = input.value ? encrypt(input.value) : null;
    else value = input.value ?? "";
  } else if (isSecret) {
    if (input.value !== undefined && input.value.length === 0) throw new ApiError("invalid_request", "A secret needs a value");
    const plain = input.value ?? (current.isSecret ? undefined : (current.value ?? ""));
    valueEncrypted = plain === undefined ? current.valueEncrypted : plain.length > 0 ? encrypt(plain) : null;
  } else {
    if (current.isSecret && input.value === undefined) throw new ApiError("invalid_request", "Enter a new value to make this variable non-secret");
    value = input.value ?? current.value ?? "";
  }
  return { isSecret, scope, value, valueEncrypted, dropPersonal };
}

export const DELETE = route<Params>({ action: "config.write", resource: "variable" }, async ({ params, workspace, actor }) => {
  const variable = await findVariable(workspace.id, params.variableId);
  await getDb().$transaction(async (tx) => {
    await tx.variable.delete({ where: { id: variable.id } });
    await audit(
      { workspaceId: workspace.id, actorId: actor.userId, action: "variable.delete", targetType: "variable", targetId: variable.id, meta: { environmentId: variable.environmentId, key: variable.key } },
      tx,
    );
  });
  return new Response(null, { status: 204 });
});
