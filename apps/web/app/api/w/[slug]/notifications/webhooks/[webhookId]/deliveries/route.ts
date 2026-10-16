import { route } from "../../../../../../../../lib/api";
import { findWebhook, recentDeliveries } from "../../../../../../../../lib/notifications";

export const dynamic = "force-dynamic";

type Params = { slug: string; webhookId: string };

export const GET = route<Params>({ action: "workspace.read", resource: "notification" }, async ({ params, workspace }) => {
  const hook = await findWebhook(workspace.id, params.webhookId);
  return Response.json({ deliveries: await recentDeliveries(hook.id) });
});
