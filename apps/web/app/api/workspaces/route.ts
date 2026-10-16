import { readJson, route } from "../../../lib/api";
import { workspaceRenameSchema } from "../../../lib/site-config";
import { createWorkspaceFor } from "../../../lib/workspaces";

export const dynamic = "force-dynamic";

/** New workspace (instance admins only, contract section 4). The creator becomes its ADMIN. */
export const POST = route({ action: "workspace.create", resource: "instance" }, async ({ request, actor }) => {
  const { name } = await readJson(request, workspaceRenameSchema);
  return Response.json(await createWorkspaceFor(actor.userId, name), { status: 201 });
});
