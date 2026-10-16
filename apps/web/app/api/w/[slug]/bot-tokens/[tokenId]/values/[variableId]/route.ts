import { readJson, route } from "../../../../../../../../lib/api";
import { botValueSchema, deleteBotValue, setBotValue } from "../../../../../../../../lib/bot-tokens";

export const dynamic = "force-dynamic";

type Params = { slug: string; tokenId: string; variableId: string };

/** The bot's own value of a personal variable (stage 5 contract section 1.1). */
export const PUT = route<Params>({ action: "botToken.write", resource: "botToken" }, async ({ request, params, workspace, actor }) => {
  const { value } = await readJson(request, botValueSchema);
  await setBotValue(workspace.id, actor.userId, params.tokenId, params.variableId, value);
  return new Response(null, { status: 204 });
});

export const DELETE = route<Params>({ action: "botToken.write", resource: "botToken" }, async ({ params, workspace, actor }) => {
  await deleteBotValue(workspace.id, actor.userId, params.tokenId, params.variableId);
  return new Response(null, { status: 204 });
});
