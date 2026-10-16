import { desktopRoute } from "../../../../../../../../../lib/desktop/auth";
import { CLAIM_TOKEN_HEADER, putArtifact } from "../../../../../../../../../lib/desktop/runs";

export const dynamic = "force-dynamic";

/** Streams one artifact; same key again replaces it. 413 past the run's total. */
export const PUT = desktopRoute<{ id: string; kind: string; attempt: string; key: string }>(async ({ request, params, principal }) => {
  return Response.json(await putArtifact(principal, params.id, params, request, request.headers.get(CLAIM_TOKEN_HEADER)), { status: 201 });
});
