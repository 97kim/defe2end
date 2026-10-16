import { mcpRoute } from "../../../../../../../lib/mcp/auth";
import * as web from "../../../../../w/[slug]/runs/test/route";

export const dynamic = "force-dynamic";

/** `run_steps`: a pre-save test run, same idempotency as `run_scenario`. */
export const POST = mcpRoute(web.POST);
