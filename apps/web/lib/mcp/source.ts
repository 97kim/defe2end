// Scenario source over MCP (stage 6 contract section 4). The desktop app's relay names the AI client in
// `X-Defe2end-Client`; session routes have no MCP principal and record nothing.
import { mcpSource, type McpClient } from "@defe2end/shared";

export const MCP_CLIENT_HEADER = "X-Defe2end-Client";

/** `mcp:claude` / `mcp:codex` / `mcp:unknown` on `/api/mcp/*`, undefined on session routes (leave the column alone). */
export function scenarioSourceOf(ctx: { request: Request; mcp?: unknown }): string | undefined {
  if (!ctx.mcp) return undefined;
  const header = ctx.request.headers.get(MCP_CLIENT_HEADER)?.trim().toLowerCase();
  const client: McpClient = header === "claude" || header === "codex" ? header : "unknown";
  return mcpSource(client);
}
