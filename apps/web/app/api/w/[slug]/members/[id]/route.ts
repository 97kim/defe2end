import { z } from "zod";
import { readJson, route } from "../../../../../../lib/api";
import { changeRole, removeMember, roleSchema } from "../../../../../../lib/accounts/members";

export const dynamic = "force-dynamic";

/** Change a member's role. Demoting the last admin answers 409. */
export const PATCH = route<{ slug: string; id: string }>({ action: "workspace.admin", resource: "member" }, async ({ request, params, workspace, actor }) => {
  const { role } = await readJson(request, z.object({ role: roleSchema }));
  const member = await changeRole({ workspaceId: workspace.id, membershipId: params.id, role, actorId: actor.userId });
  return Response.json({ id: member.id, role: member.role });
});

/** Remove a member. Removing the last admin answers 409. */
export const DELETE = route<{ slug: string; id: string }>({ action: "workspace.admin", resource: "member" }, async ({ params, workspace, actor }) => {
  await removeMember({ workspaceId: workspace.id, membershipId: params.id, actorId: actor.userId });
  return new Response(null, { status: 204 });
});
