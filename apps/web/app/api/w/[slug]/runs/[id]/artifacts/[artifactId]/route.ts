import { Readable } from "node:stream";
import { ApiError, route } from "../../../../../../../../lib/api";
import { findArtifact } from "../../../../../../../../lib/runs";
import { getStorage } from "../../../../../../../../lib/storage";

export const dynamic = "force-dynamic";

const EXTENSIONS = { screenshot: "png", video: "webm", trace: "zip", log: "txt", dom_summary: "txt", visual_diff: "png", a11y_snapshot: "txt" } as const;

/**
 * Serves a run file from the app's origin, so it must never be executable there: fixed content type per kind,
 * nosniff, a sandboxing CSP, and anything but images as an attachment.
 */
export const GET = route<{ slug: string; id: string; artifactId: string }>({ action: "run.read", resource: "artifact" }, async ({ params, workspace }) => {
  const artifact = await findArtifact(workspace.id, params.id, params.artifactId);
  let body: Readable;
  try {
    body = await getStorage().get(artifact.storageKey);
  } catch {
    throw ApiError.notFound();
  }
  const filename = `${artifact.kind}-${artifact.id}.${EXTENSIONS[artifact.kind]}`;
  return new Response(Readable.toWeb(body) as ReadableStream, {
    headers: {
      "content-type": artifact.contentType,
      "content-length": String(artifact.sizeBytes),
      "content-disposition": `${artifact.kind === "screenshot" ? "inline" : "attachment"}; filename="${filename}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
});
