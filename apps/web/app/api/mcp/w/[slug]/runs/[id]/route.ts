import { isTerminalRunStatus } from "@defe2end/shared";
import { ApiError, errorResponse } from "../../../../../../../lib/api";
import { mcpRoute, mcpStillAllowed } from "../../../../../../../lib/mcp/auth";
import { getRunDetail } from "../../../../../../../lib/runs";

export const dynamic = "force-dynamic";

/** At most 25 seconds, inside the desktop socket's 30 (stage 6 contract section 4). */
export const MCP_RUN_WAIT_MAX_SECONDS = 25;

/** `get_run`: the run's detail; `?wait=<seconds>` holds until it ends, reading once a second; stops on disconnect. */
export const GET = mcpRoute({ action: "run.read", resource: "run" }, async ({ request, params, workspace, mcp }) => {
  const raw = new URL(request.url).searchParams.get("wait");
  const wait = raw === null ? 0 : Number(raw);
  if (!Number.isInteger(wait) || wait < 0 || wait > MCP_RUN_WAIT_MAX_SECONDS) throw new ApiError("invalid_request", `wait must be a whole number of seconds from 0 to ${MCP_RUN_WAIT_MAX_SECONDS}`);
  const deadline = Date.now() + wait * 1000;
  let run = await getRunDetail(workspace!, params.id as string);
  while (!isTerminalRunStatus(run.status) && Date.now() < deadline && !request.signal.aborted) {
    await new Promise((r) => setTimeout(r, Math.min(1000, deadline - Date.now())));
    // Leaving the workspace or a revoked token ends the wait without more data.
    if (!(await mcpStillAllowed(mcp, "run.read", workspace!.id))) return errorResponse("unauthenticated", "A valid MCP token with access to this workspace is required");
    run = await getRunDetail(workspace!, params.id as string);
  }
  return Response.json(run);
});
