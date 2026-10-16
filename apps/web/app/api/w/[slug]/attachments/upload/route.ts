import { Readable } from "node:stream";
import { ApiError, route } from "../../../../../../lib/api";
import { attachmentLimits, attachmentNameSchema, storeAttachment } from "../../../../../../lib/attachment-write";
import { audit } from "../../../../../../lib/audit";

export const dynamic = "force-dynamic";

// Room for the multipart headers and the name field around the file.
const FORM_OVERHEAD = 64 * 1024;

/**
 * Uploads a file for `upload` steps (multipart: `file`, optional `name`, default the file's name). The same
 * name again adds a new version. 413 over 20 MB per file or 500 MB per workspace.
 */
export const POST = route({ action: "attachment.write", resource: "attachment" }, async ({ request, workspace, actor }) => {
  const length = Number(request.headers.get("content-length"));
  if (!request.headers.get("content-length") || !Number.isFinite(length)) throw new ApiError("invalid_request", "Content-Length is required");
  const { fileBytes } = attachmentLimits();
  if (length > fileBytes + FORM_OVERHEAD) throw new ApiError("payload_too_large", `The file is over the ${Math.round(fileBytes / 1024 / 1024)} MB limit`);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError("invalid_request", "Send the file as multipart/form-data");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError("invalid_request", "The form needs a file field");
  const rawName = form.get("name");
  const name = attachmentNameSchema.parse(typeof rawName === "string" && rawName.trim() ? rawName : file.name);
  const stored = await storeAttachment({
    workspaceId: workspace.id,
    name,
    contentType: file.type || "application/octet-stream",
    body: Readable.fromWeb(file.stream() as import("node:stream/web").ReadableStream<Uint8Array>),
  });
  await audit({ workspaceId: workspace.id, actorId: actor.userId, action: "attachment.upload", targetType: "attachment", targetId: stored.id, meta: { name: stored.name, version: stored.version, sizeBytes: stored.sizeBytes } });
  return Response.json(stored, { status: 201 });
});
