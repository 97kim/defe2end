import { desktopHeartbeatRequestSchema } from "@defe2end/shared";
import { desktopRoute } from "../../../../../../lib/desktop/auth";
import { heartbeatRun } from "../../../../../../lib/desktop/runs";

export const dynamic = "force-dynamic";

/** Extends a live lease by 90 seconds; 409 lease_lost once it expired. */
export const POST = desktopRoute<{ id: string }>(async ({ request, params, principal }) => {
  const { claimToken } = desktopHeartbeatRequestSchema.parse(await request.json());
  return Response.json(await heartbeatRun(principal, params.id, claimToken));
});
