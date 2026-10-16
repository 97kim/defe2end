import { route } from "../../../../../../lib/api";
import { revokeInvite } from "../../../../../../lib/accounts/invites";

export const dynamic = "force-dynamic";

/** Revoke a pending invite. */
export const DELETE = route<{ slug: string; id: string }>({ action: "workspace.admin", resource: "invite" }, async ({ params, workspace, actor }) => {
  await revokeInvite({ workspaceId: workspace.id, inviteId: params.id, actorId: actor.userId });
  return new Response(null, { status: 204 });
});
