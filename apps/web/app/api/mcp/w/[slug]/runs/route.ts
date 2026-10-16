import { mcpRoute } from "../../../../../../lib/mcp/auth";
import * as web from "../../../../w/[slug]/runs/route";

export const dynamic = "force-dynamic";

/** `run_scenario`: answers the run id at once; the `Idempotency-Key` header makes a retry return the same run. */
export const POST = mcpRoute(web.POST);
