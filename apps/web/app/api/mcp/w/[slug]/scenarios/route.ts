import { mcpRoute } from "../../../../../../lib/mcp/auth";
import * as web from "../../../../w/[slug]/scenarios/route";

export const dynamic = "force-dynamic";

export const GET = mcpRoute(web.GET);
export const POST = mcpRoute(web.POST);
