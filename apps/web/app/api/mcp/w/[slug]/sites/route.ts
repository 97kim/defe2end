import { mcpRoute } from "../../../../../../lib/mcp/auth";
import * as web from "../../../../w/[slug]/sites/route";

export const dynamic = "force-dynamic";

/** `list_sites` / `list_environments`: sites with their environments (no variable values). */
export const GET = mcpRoute(web.GET);
