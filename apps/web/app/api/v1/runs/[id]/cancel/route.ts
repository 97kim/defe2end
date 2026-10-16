import { botRoute, cancelApiRun } from "../../../../../../lib/api-v1";

export const dynamic = "force-dynamic";

/** A queued run ends `cancelled` at once; a running one is asked to stop. Repeating answers the same. */
export const POST = botRoute<{ id: string }>("runs:cancel", async ({ params, bot }) => {
  return Response.json(await cancelApiRun(bot, params.id));
});
