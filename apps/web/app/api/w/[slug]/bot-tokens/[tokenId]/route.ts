import { route } from "../../../../../../lib/api";
import { getBotDetail, revokeBotToken } from "../../../../../../lib/bot-tokens";

export const dynamic = "force-dynamic";

type Params = { slug: string; tokenId: string };

/** The token with its own values (secrets as `hasValue` only) and login session status per environment. */
export const GET = route<Params>({ action: "workspace.read", resource: "botToken" }, async ({ params, workspace }) => {
  return Response.json(await getBotDetail(workspace.id, params.tokenId));
});

/** Revokes the token; it stops working at once. */
export const DELETE = route<Params>({ action: "botToken.write", resource: "botToken" }, async ({ params, workspace, actor }) => {
  await revokeBotToken(workspace.id, actor.userId, params.tokenId);
  return new Response(null, { status: 204 });
});
