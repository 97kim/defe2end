import { route } from "../../../../../lib/api";
import { listOwnAuthSessions } from "../../../../../lib/auth-sessions";

export const dynamic = "force-dynamic";

/** The caller's own login sessions in this workspace, metadata only. */
export const GET = route({ action: "workspace.read", resource: "authSession" }, async ({ workspace, actor }) => {
  return Response.json({ items: await listOwnAuthSessions(workspace.id, actor.userId) });
});
