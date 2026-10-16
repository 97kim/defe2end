import { lockAndRevalidateActor } from "../../../../lib/accounts/admin-lock";
import { ApiError, readJson, route } from "../../../../lib/api";
import { audit } from "../../../../lib/audit";
import { getDb } from "../../../../lib/db";
import { workspaceDeleteSchema, workspaceUpdateSchema } from "../../../../lib/site-config";

export const dynamic = "force-dynamic";

/** Workspace summary for the shell. */
export const GET = route({ action: "workspace.read", resource: "workspace" }, async ({ workspace, actor }) => {
  const memberCount = await getDb().membership.count({ where: { workspaceId: workspace.id } });
  return Response.json({
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    locale: workspace.locale,
    timezone: workspace.timezone,
    role: actor.roles[workspace.id],
    memberCount,
  });
});

/** Rename the workspace (the slug stays, so links keep working), or set its message language and time zone. */
export const PATCH = route({ action: "workspace.admin", resource: "workspace" }, async ({ request, workspace, actor }) => {
  const { name, locale, timezone } = await readJson(request, workspaceUpdateSchema);
  const db = getDb();
  const updated = await db.$transaction(async (tx) => {
    const ws = await tx.workspace.update({ where: { id: workspace.id }, data: { name, locale, timezone } });
    if (name !== undefined && name !== workspace.name) {
      await audit(
        { workspaceId: workspace.id, actorId: actor.userId, action: "workspace.rename", targetType: "workspace", targetId: workspace.id, meta: { from: workspace.name, to: name } },
        tx,
      );
    }
    if ((locale !== undefined && locale !== workspace.locale) || (timezone !== undefined && timezone !== workspace.timezone)) {
      await audit(
        { workspaceId: workspace.id, actorId: actor.userId, action: "workspace.update", targetType: "workspace", targetId: workspace.id, meta: { locale, timezone } },
        tx,
      );
    }
    return ws;
  });
  return Response.json({ id: updated.id, name: updated.name, slug: updated.slug, locale: updated.locale, timezone: updated.timezone });
});

/** Delete the workspace and everything in it. The body must repeat the current name. */
export const DELETE = route({ action: "workspace.admin", resource: "workspace" }, async ({ request, workspace, actor }) => {
  const { confirmName } = await readJson(request, workspaceDeleteSchema);
  if (confirmName !== workspace.name) throw new ApiError("invalid_request", "Type the workspace name to confirm");
  await getDb().$transaction(async (tx) => {
    // Memberships go with the workspace (cascade), so take the shared admin-membership lock first,
    // and re-check that the actor is still an active ADMIN here.
    await lockAndRevalidateActor(tx, actor.userId, { kind: "workspaceAdmin", workspaceId: workspace.id });
    // Kept after the delete with workspaceId set to null (onDelete: SetNull).
    await audit(
      { workspaceId: workspace.id, actorId: actor.userId, action: "workspace.delete", targetType: "workspace", targetId: workspace.id, meta: { name: workspace.name, slug: workspace.slug } },
      tx,
    );
    await tx.workspace.delete({ where: { id: workspace.id } });
  });
  return new Response(null, { status: 204 });
});
