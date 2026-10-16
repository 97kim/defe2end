import { desktopCompleteRequestSchema } from "@defe2end/shared";
import { desktopRoute } from "../../../../../../lib/desktop/auth";
import { completeRun } from "../../../../../../lib/desktop/runs";

export const dynamic = "force-dynamic";

/** Final result with every attempt's steps; 409 run_finalized when the run already ended. */
export const POST = desktopRoute<{ id: string }>(async ({ request, params, principal }) => {
  return Response.json(await completeRun(principal, params.id, desktopCompleteRequestSchema.parse(await request.json())));
});
