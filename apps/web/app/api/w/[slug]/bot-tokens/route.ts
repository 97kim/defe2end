import { readJson, route } from "../../../../../lib/api";
import { createBotToken, createBotTokenSchema, listBotTokens } from "../../../../../lib/bot-tokens";

export const dynamic = "force-dynamic";

/** Name, first 8 characters, scopes, expiry, last use and creator — never the token. */
export const GET = route({ action: "workspace.read", resource: "botToken" }, async ({ workspace }) => {
  return Response.json({ items: await listBotTokens(workspace.id) });
});

/** The raw `d2e_…` token is in this response only. */
export const POST = route({ action: "botToken.write", resource: "botToken" }, async ({ request, workspace, actor }) => {
  const input = await readJson(request, createBotTokenSchema);
  return Response.json(await createBotToken(workspace.id, actor.userId, input), { status: 201 });
});
