import { mcpRoute } from "../../../../../../lib/mcp/auth";
import * as web from "../../../../w/[slug]/schedules/route";

export const dynamic = "force-dynamic";

/** Schedule values and sessions stay web-only. */
export const GET = mcpRoute(web.GET);
export const POST = mcpRoute(web.POST);
