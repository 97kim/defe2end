// The stdio MCP server: every tool is one call on the desktop app's socket with `op` = the tool name.
import { randomUUID } from "node:crypto";
import { isMcpToolName, MCP_TOOLS, mcpToolInputSchemas, type McpClient } from "@defe2end/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { Connector } from "./locate.js";
import { AppSocketClient } from "./socket-client.js";
import { formatError, formatResult, listTools } from "./tools.js";
import { MCP_VERSION } from "./version.js";

/** `DEFE2END_MCP_CLIENT` (claude|codex) wins; otherwise the MCP client's `initialize.clientInfo.name`. */
export function detectClient(clientName: string | undefined, env: NodeJS.ProcessEnv = process.env): McpClient {
  const forced = env.DEFE2END_MCP_CLIENT?.trim().toLowerCase();
  if (forced === "claude" || forced === "codex") return forced;
  const name = (clientName ?? "").toLowerCase();
  if (name.includes("claude")) return "claude";
  if (name.includes("codex")) return "codex";
  return "unknown";
}

export interface Defe2endMcpOptions {
  connector: Connector;
  env?: NodeJS.ProcessEnv;
  /** Socket reply timeout; tests shorten it. */
  timeoutMs?: number;
  newIdempotencyKey?: () => string;
}

export function createDefe2endMcpServer(options: Defe2endMcpOptions) {
  const socket = new AppSocketClient(options.connector, options.timeoutMs);
  const newKey = options.newIdempotencyKey ?? randomUUID;
  const server = new Server({ name: "defe2end", version: MCP_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    if (!isMcpToolName(name)) return formatError({ code: "unknown-op", message: `Unknown tool: ${name.slice(0, 64)}` });
    const parsed = (mcpToolInputSchemas[name] as z.ZodType<Record<string, unknown>>).safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
      return formatError({ code: "invalid-args", message });
    }
    const meta = MCP_TOOLS[name];
    const isRun = meta.kind === "run";
    // One key per tool call, reused by the retry below so a lost reply still returns the same run.
    const args = isRun ? { ...parsed.data, idempotencyKey: newKey() } : parsed.data;
    const outcome = await socket.call(name, args, {
      client: detectClient(server.getClientVersion()?.name, options.env),
      signal: extra.signal,
      retryOnDrop: meta.annotations.idempotentHint,
      retryOnTimeout: isRun,
    });
    return outcome.ok ? formatResult(name, outcome.result) : formatError(outcome.error);
  });

  return { server, close: () => socket.close() };
}
