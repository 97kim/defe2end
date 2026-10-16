import { route } from "../../../../../lib/api";
import { listAttachments } from "../../../../../lib/attachments";

export const dynamic = "force-dynamic";

export const GET = route({ action: "workspace.read", resource: "attachment" }, async ({ workspace }) => {
  return Response.json({ attachments: await listAttachments(workspace) });
});
