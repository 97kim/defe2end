import { can } from "@defe2end/shared";
import { listPendingInvites } from "../../../../../lib/accounts/invites";
import { listMembers } from "../../../../../lib/accounts/members";
import { requireWorkspace } from "../../../../../lib/page";
import { MembersView } from "./members-view";

export const dynamic = "force-dynamic";

/** Settings › Members. The settings layout draws the header and tabs; this renders the body. */
export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { actor, workspace } = await requireWorkspace(slug);
  const isAdmin = can(actor, "workspace.admin", { type: "member", workspaceId: workspace.id }) === "allow";
  const [members, invites] = await Promise.all([listMembers(workspace.id), isAdmin ? listPendingInvites(workspace.id) : Promise.resolve([])]);
  return <MembersView slug={slug} isAdmin={isAdmin} currentUserId={actor.userId} members={members} invites={invites} />;
}
