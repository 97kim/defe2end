import { desktopRoute } from "../../../../../../lib/desktop/auth";
import { startRun } from "../../../../../../lib/desktop/runs";

export const dynamic = "force-dynamic";

/** Conditional start; repeating it while the lease is live returns the same claim token. */
export const POST = desktopRoute<{ id: string }>(async ({ params, principal }) => Response.json(await startRun(principal, params.id)));
