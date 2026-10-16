import { route } from "../../../../../../lib/api";
import { issueResetLink } from "../../../../../../lib/accounts/reset-links";

export const dynamic = "force-dynamic";

/** Issue a one-time reset link (1 hour). The token is in this response only; the link is `/reset#token=<token>`. */
export const POST = route<{ id: string }>({ action: "user.resetLink", resource: "instance" }, async ({ params, actor }) => {
  const link = await issueResetLink({ userId: params.id, actorId: actor.userId });
  return Response.json(link, { status: 201, headers: { "cache-control": "no-store" } });
});
