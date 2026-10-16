import { readJson, route } from "../../../../../../../lib/api";
import { audit } from "../../../../../../../lib/audit";
import { getDb } from "../../../../../../../lib/db";
import { encrypt } from "../../../../../../../lib/encryption";
import { findWebhook, urlHintOf, webhookUpdateSchema, webhookView } from "../../../../../../../lib/notifications";

export const dynamic = "force-dynamic";

type Params = { slug: string; webhookId: string };

/** An empty `url` keeps the stored one; `invalid: false` clears the invalid mark. */
export const PATCH = route<Params>({ action: "notification.write", resource: "notification" }, async ({ request, params, workspace, actor }) => {
  const hook = await findWebhook(workspace.id, params.webhookId);
  const { url, invalid, ...rest } = await readJson(request, webhookUpdateSchema);
  const updated = await getDb().$transaction(async (tx) => {
    const h = await tx.slackWebhook.update({
      where: { id: hook.id },
      data: { ...rest, ...(url ? { urlEncrypted: encrypt(url), urlHint: urlHintOf(url), invalidAt: null } : {}), ...(invalid === false ? { invalidAt: null } : {}) },
    });
    await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "webhook.update", targetType: "webhook", targetId: h.id, meta: { fields: Object.keys(rest), urlChanged: !!url, reenabled: invalid === false } }, tx);
    return h;
  });
  return Response.json(webhookView(updated));
});

export const DELETE = route<Params>({ action: "notification.write", resource: "notification" }, async ({ params, workspace, actor }) => {
  const hook = await findWebhook(workspace.id, params.webhookId);
  await getDb().$transaction(async (tx) => {
    await tx.slackWebhook.delete({ where: { id: hook.id } });
    await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "webhook.delete", targetType: "webhook", targetId: hook.id, meta: { name: hook.name } }, tx);
  });
  return new Response(null, { status: 204 });
});
