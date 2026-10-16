import { route } from "../../../../../lib/api";
import { listMembers } from "../../../../../lib/accounts/members";

export const dynamic = "force-dynamic";

/** Members with their roles; every member may read it. */
export const GET = route({ action: "workspace.read", resource: "member" }, async ({ workspace }) => {
  return Response.json({ members: await listMembers(workspace.id) });
});
