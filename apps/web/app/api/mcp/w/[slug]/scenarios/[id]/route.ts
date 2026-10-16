import { mcpRoute } from "../../../../../../../lib/mcp/auth";
import * as web from "../../../../../w/[slug]/scenarios/[id]/route";

export const dynamic = "force-dynamic";

/** Read and change; no delete (stage 6 contract section 4). */
export const GET = mcpRoute(web.GET);
export const PATCH = mcpRoute(web.PATCH);
