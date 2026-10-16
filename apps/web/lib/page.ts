import { can, type Action } from "@defe2end/shared";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { cache } from "react";
import { getActor } from "./actor";
import { getDb } from "./db";

/** Signed-in actor for server components; redirects to /login when signed out. Cached per request. */
export const requireActor = cache(async () => {
  const actor = await getActor(await headers());
  if (!actor) redirect("/login");
  return actor;
});

/**
 * Workspace page data behind the same `can()` check as the API.
 * Not a member (or no such workspace) → 404 page. Cached per request, so layout and page share it.
 */
export const requireWorkspace = cache(async (slug: string) => {
  const actor = await requireActor();
  const workspace = await getDb().workspace.findUnique({ where: { slug } });
  if (!workspace || can(actor, "workspace.read", { type: "workspace", workspaceId: workspace.id }) !== "allow") {
    notFound();
  }
  return { actor, workspace, role: actor.roles[workspace.id]! };
});

/** For pages that need more than read access: render <AccessDenied /> when this is false. */
export async function canInWorkspace(slug: string, action: Action): Promise<boolean> {
  const { actor, workspace } = await requireWorkspace(slug);
  return can(actor, action, { type: "workspace", workspaceId: workspace.id }) === "allow";
}

/** Workspaces the actor belongs to, for the switcher and the 404 page. */
export async function listMyWorkspaces(userId: string) {
  const memberships = await getDb().membership.findMany({
    where: { userId },
    select: { role: true, workspace: { select: { id: true, name: true, slug: true, _count: { select: { memberships: true } } } } },
    orderBy: { workspace: { name: "asc" } },
  });
  return memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    role: m.role,
    memberCount: m.workspace._count.memberships,
  }));
}
