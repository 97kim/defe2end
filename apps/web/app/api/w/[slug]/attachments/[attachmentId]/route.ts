import { Readable } from "node:stream";
import { ApiError, route } from "../../../../../../lib/api";
import { audit } from "../../../../../../lib/audit";
import { contentDisposition, deleteAttachment, findAttachment } from "../../../../../../lib/attachments";
import { getStorage } from "../../../../../../lib/storage";

export const dynamic = "force-dynamic";

/**
 * Uploaded files can be anything (HTML included), so they are never rendered from the app's origin:
 * always a download, an opaque content type, nosniff and a sandboxing CSP.
 */
export const GET = route<{ slug: string; attachmentId: string }>({ action: "workspace.read", resource: "attachment" }, async ({ params, workspace }) => {
  const attachment = await findAttachment(workspace.id, params.attachmentId);
  let body: Readable;
  try {
    body = await getStorage().get(attachment.storageKey);
  } catch {
    throw ApiError.notFound();
  }
  return new Response(Readable.toWeb(body) as ReadableStream, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(attachment.sizeBytes),
      "content-disposition": contentDisposition(attachment.name),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
});

export const DELETE = route<{ slug: string; attachmentId: string }>({ action: "attachment.write", resource: "attachment" }, async ({ params, workspace, actor }) => {
  const deleted = await deleteAttachment(workspace.id, params.attachmentId);
  await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "attachment.delete", targetType: "attachment", targetId: params.attachmentId, meta: deleted });
  return new Response(null, { status: 204 });
});
