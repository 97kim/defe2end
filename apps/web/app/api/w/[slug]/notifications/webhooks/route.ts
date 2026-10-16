import { readJson, route } from "../../../../../../lib/api";
import { audit } from "../../../../../../lib/audit";
import { getDb } from "../../../../../../lib/db";
import { encrypt } from "../../../../../../lib/encryption";
import { urlHintOf, webhookCreateSchema, webhookView } from "../../../../../../lib/notifications";

export const dynamic = "force-dynamic";

export const GET = route({ action: "workspace.read", resource: "notification" }, async ({ workspace }) => {
  const hooks = await getDb().slackWebhook.findMany({ where: { workspaceId: workspace.id }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  return Response.json({ webhooks: hooks.map(webhookView) });
});

/** The URL is stored encrypted with the install key and never returned (only its last 4 characters). */
export const POST = route({ action: "notification.write", resource: "notification" }, async ({ request, workspace, actor }) => {
  const input = await readJson(request, webhookCreateSchema);
  const hook = await getDb().$transaction(async (tx) => {
    const h = await tx.slackWebhook.create({
      data: {
        workspaceId: workspace.id,
        name: input.name,
        urlEncrypted: encrypt(input.url),
        urlHint: urlHintOf(input.url),
        notifyOn: input.notifyOn,
        sources: input.sources,
        dailyReport: input.dailyReport,
        reportTime: input.reportTime,
        reportTimezone: input.reportTimezone,
        createdById: actor.userId,
      },
    });
    await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "webhook.create", targetType: "webhook", targetId: h.id, meta: { name: h.name } }, tx);
    return h;
  });
  return Response.json(webhookView(hook), { status: 201 });
});
