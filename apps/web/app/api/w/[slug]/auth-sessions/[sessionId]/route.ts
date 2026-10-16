import { route } from "../../../../../../lib/api";
import { deleteOwnAuthSession } from "../../../../../../lib/auth-sessions";

export const dynamic = "force-dynamic";

/** Deletes one of the caller's own sessions; anyone else's is a 404. */
export const DELETE = route<{ slug: string; sessionId: string }>({ action: "authSession.write", resource: "authSession" }, async ({ params, workspace, actor }) => {
  await deleteOwnAuthSession(workspace.id, actor.userId, params.sessionId);
  return new Response(null, { status: 204 });
});
