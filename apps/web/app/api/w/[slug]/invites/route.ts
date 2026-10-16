import { readJson, route } from "../../../../../lib/api";
import { createInvite, inviteInputSchema, listPendingInvites } from "../../../../../lib/accounts/invites";

export const dynamic = "force-dynamic";

/** Pending invites (admins only: they carry the emails of people who haven't joined). */
export const GET = route({ action: "workspace.admin", resource: "invite" }, async ({ workspace }) => {
  return Response.json({ invites: await listPendingInvites(workspace.id) });
});

/** Issue an invite. The response carries the token once; the link is `/invite#token=<token>`. */
export const POST = route({ action: "workspace.admin", resource: "invite" }, async ({ request, workspace, actor }) => {
  const body = await readJson(request, inviteInputSchema);
  const invite = await createInvite({ workspaceId: workspace.id, email: body.email, role: body.role, actorId: actor.userId });
  return Response.json(invite, { status: 201, headers: { "cache-control": "no-store" } });
});
