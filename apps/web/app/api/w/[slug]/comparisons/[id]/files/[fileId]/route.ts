import { Readable } from "node:stream";
import { route } from "../../../../../../../../lib/api";
import { comparisonFile } from "../../../../../../../../lib/env-comparisons";

export const dynamic = "force-dynamic";

/** A diff image (PNG) or structure diff (JSON) of the comparison. */
export const GET = route<{ slug: string; id: string; fileId: string }>({ action: "run.read", resource: "run" }, async ({ params, workspace }) => {
  const file = await comparisonFile(workspace.id, params.id, params.fileId);
  return new Response(Readable.toWeb(file.stream) as ReadableStream, { headers: { "content-type": file.contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
