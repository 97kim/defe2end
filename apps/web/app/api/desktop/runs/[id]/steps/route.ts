import { desktopStepsRequestSchema } from "@defe2end/shared";
import { desktopRoute } from "../../../../../../lib/desktop/auth";
import { recordSteps } from "../../../../../../lib/desktop/runs";

export const dynamic = "force-dynamic";

/** Live step progress, best effort; the completion restores anything lost. */
export const POST = desktopRoute<{ id: string }>(async ({ request, params, principal }) => {
  await recordSteps(principal, params.id, desktopStepsRequestSchema.parse(await request.json()));
  return new Response(null, { status: 204 });
});
