import { getDb } from "../../../../lib/db";
import { mcpRoute } from "../../../../lib/mcp/auth";

export const dynamic = "force-dynamic";

/** `list_workspaces`: the token user's workspaces and role. */
export const GET = mcpRoute({ action: "desktop.connect", resource: "instance" }, async ({ actor }) => {
  const ids = Object.keys(actor.roles);
  const rows = await getDb().workspace.findMany({ where: { id: { in: ids } }, orderBy: { name: "asc" }, select: { id: true, slug: true, name: true } });
  return Response.json({ workspaces: rows.map((w) => ({ ...w, role: actor.roles[w.id] })) });
});
