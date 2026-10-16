import { sendTestNotification } from "@defe2end/db";
import { route } from "../../../../../../../../lib/api";
import { getDb } from "../../../../../../../../lib/db";
import { decrypt } from "../../../../../../../../lib/encryption";
import { findWebhook } from "../../../../../../../../lib/notifications";

export const dynamic = "force-dynamic";

type Params = { slug: string; webhookId: string };

/** Sends straight to this webhook (no queue, no retry) and answers the outcome; the attempt is recorded. */
export const POST = route<Params>({ action: "notification.write", resource: "notification" }, async ({ params, workspace }) => {
  const hook = await findWebhook(workspace.id, params.webhookId);
  const result = await sendTestNotification(getDb(), hook.id, { decrypt });
  return Response.json(result);
});
