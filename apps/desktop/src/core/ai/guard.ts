// Stage 6 contract section 7, "run only what is checked": there is no upper CLI version bound, so every turn checks
// at run time that the CLI holds the launch limits.
// - Claude: before the user's message goes in, the app asks the CLI over the stream-json control protocol for its
//   MCP servers (`mcp_status`) and context makeup (`get_context_usage`: built-in tools show as a "System tools"
//   category, MCP tools are listed by name). Claude sends `system/init` only after the first user message, so the
//   init event is checked again when it comes.
// - Codex has no such handshake: its `--json` items are watched and the first item that isn't a reply, reasoning or
//   an allowed defe2end MCP call ends the process tree (after the fact — the first such call may already have run).
export const MCP_SERVER = "defe2end";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER}__`;

/** `get_context_usage` categories a restricted session may have. Anything else (e.g. "System tools") refuses. */
const SAFE_CONTEXT_CATEGORIES = new Set(["System prompt", "Messages", "Autocompact buffer", "Free space", "MCP tools", "Memory files"]);

/** Null when the Claude session holds the limits; otherwise why not. `allowMcp` is false for diagnosis. */
export function checkClaudePreflight(mcpStatus: unknown, usage: unknown, allowMcp: boolean): string | null {
  const servers = (mcpStatus as { mcpServers?: unknown } | null)?.mcpServers;
  if (!Array.isArray(servers)) return "mcp_status has no server list";
  for (const s of servers) {
    const name = (s as { name?: unknown } | null)?.name;
    if (typeof name !== "string") return "mcp_status server without a name";
    if (!allowMcp || name !== MCP_SERVER) return `unexpected MCP server ${name}`;
  }
  const u = usage as { categories?: unknown; mcpTools?: unknown } | null;
  if (!Array.isArray(u?.categories) || !Array.isArray(u.mcpTools)) return "context usage has an unknown shape";
  for (const c of u.categories) {
    const name = (c as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !SAFE_CONTEXT_CATEGORIES.has(name)) return `unexpected context category ${String(name)}`;
  }
  for (const t of u.mcpTools) {
    const name = (t as { name?: unknown } | null)?.name;
    if (typeof name !== "string") return "MCP tool without a name";
    if (!allowMcp || !name.startsWith(MCP_TOOL_PREFIX)) return `unexpected tool ${name}`;
  }
  return null;
}

/** The `system/init` event: only defe2end MCP tools and server (chat), nothing at all (diagnosis). */
export function checkClaudeInit(msg: unknown, allowMcp: boolean): string | null {
  const m = msg as { tools?: unknown; mcp_servers?: unknown } | null;
  if (!Array.isArray(m?.tools) || !Array.isArray(m.mcp_servers)) return "init has an unknown shape";
  for (const tool of m.tools) {
    if (typeof tool !== "string") return "init tool without a name";
    if (!allowMcp || !tool.startsWith(MCP_TOOL_PREFIX)) return `unexpected tool ${tool}`;
  }
  for (const s of m.mcp_servers) {
    const name = (s as { name?: unknown } | null)?.name;
    if (!allowMcp || name !== MCP_SERVER) return `unexpected MCP server ${String(name)}`;
  }
  return null;
}

// Event lists from this Mac's real output (Claude Code 2.1.300, codex-cli 0.162.1, 2026-10-16) plus the documented
// neighbours of the same families. Anything else — a new event, a missing field, a non-JSON line — refuses: a CLI we
// can't read is a CLI we can't vouch for.
const CLAUDE_EVENTS = new Set(["system", "stream_event", "assistant", "user", "result", "rate_limit_event", "control_response"]);
// Seen on 2.1.300: `permission_denied` (a tool call the CLI refused, nothing ran), `thinking_tokens` (thinking progress).
const CLAUDE_SYSTEM = new Set(["init", "status", "api_retry", "compact_boundary", "permission_denied", "thinking_tokens"]);
const CLAUDE_STREAM = new Set(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);

/** Null when a Claude stdout event is one of the known kinds (`init` is checked by `checkClaudeInit`). */
export function claudeEventProblem(msg: unknown): string | null {
  const m = msg as { type?: unknown; subtype?: unknown; event?: { type?: unknown } } | null;
  if (typeof m?.type !== "string" || !CLAUDE_EVENTS.has(m.type)) return `unknown event ${String(m?.type)}`;
  if (m.type === "system" && !(typeof m.subtype === "string" && CLAUDE_SYSTEM.has(m.subtype))) return `unknown system event ${String(m.subtype)}`;
  if (m.type === "stream_event" && !(typeof m.event?.type === "string" && CLAUDE_STREAM.has(m.event.type))) return `unknown stream event ${String(m.event?.type)}`;
  return null;
}

const CODEX_EVENTS = new Set(["thread.started", "turn.started", "turn.completed", "turn.failed", "error", "item.started", "item.updated", "item.completed"]);
const CODEX_QUIET_ITEMS = new Set(["agent_message", "reasoning", "error", "todo_list"]);

/** A Codex `--json` event that isn't known, or runs something other than allowed: null when fine. */
export function codexViolation(msg: unknown, allowMcp: boolean): string | null {
  const m = msg as { type?: unknown; item?: { type?: unknown; server?: unknown; tool?: unknown } } | null;
  if (typeof m?.type !== "string" || !CODEX_EVENTS.has(m.type)) return `unknown event ${String(m?.type)}`;
  if (!m.type.startsWith("item.")) return null;
  if (typeof m.item !== "object" || m.item === null || typeof m.item.type !== "string") return "item without a type";
  const kind = m.item.type;
  if (CODEX_QUIET_ITEMS.has(kind)) return null;
  if (kind === "mcp_tool_call" && allowMcp && m.item.server === MCP_SERVER) return null;
  return kind === "mcp_tool_call" ? `MCP call ${String(m.item.server)}/${String(m.item.tool)}` : `tool item ${kind}`;
}
