import { Readable } from "node:stream";
import { ApiError, route } from "../../../../../../../../lib/api";
import { getDb } from "../../../../../../../../lib/db";
import { getStorage } from "../../../../../../../../lib/storage";

export const dynamic = "force-dynamic";

/** A baseline image a step result of this run was judged with (stage 7 contract section 4). */
export const GET = route<{ slug: string; id: string; versionId: string }>({ action: "run.read", resource: "run" }, async ({ params, workspace }) => {
  const used = await getDb().stepResult.findFirst({
    where: { runId: params.id, visualBaselineVersionId: params.versionId, run: { workspaceId: workspace.id } },
    select: { visualBaselineVersion: { select: { storageKey: true } } },
  });
  const key = used?.visualBaselineVersion?.storageKey;
  if (!key) throw ApiError.notFound();
  let body: Readable;
  let size: number;
  try {
    const stat = await getStorage().stat(key);
    if (!stat) throw new Error("missing");
    size = stat.sizeBytes;
    body = await getStorage().get(key);
  } catch {
    throw ApiError.notFound();
  }
  return new Response(Readable.toWeb(body) as ReadableStream, {
    headers: {
      "content-type": "image/png",
      "content-length": String(size),
      "content-disposition": `inline; filename="baseline-${params.versionId}.png"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
});
