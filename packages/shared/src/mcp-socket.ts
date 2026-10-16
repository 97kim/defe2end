// Stage 6 contract section 5: the local socket between `defe2end-mcp` (client) and the desktop app (server).
// One JSON object per line, UTF-8, in both directions. Every MCP tool is one socket op with the same name: browser
// ops are run by the app on the side browser, domain ops are relayed by the app to `/api/mcp/*` with its MCP token
// (the AI-side process never sees a server token). The app re-validates `args` with `parseMcpSocketArgs`.
//
// Client → app:
//   { type?: "call", id, token, op, args, client? }   run a tool (`type` may be left out)
//   { type: "cancel", id, token }                     stop waiting/acting for call `id` (no-op when it already ended)
//   { type: "hello", id, token }                      who is signed in: { identity } (`McpSocketHello`), sent first on
//                                                     each connection; `defe2end-mcp` pins the first identity it sees
// App → client (exactly one per call, also for a cancelled call):
//   { id, ok: true, result } | { id, ok: false, error: { code, message, keys? } }
// A wrong or stale session token, or a line that isn't a valid message, closes the connection without a reply
// (the id can't be trusted). Closing the connection cancels every call still running on it.
import { z } from "zod";
import { idempotencyKeySchema } from "./api-v1.js";
import { MCP_CLIENTS, MCP_TOOL_NAMES, mcpToolInputSchemas, type McpToolName } from "./mcp-tools.js";

export const MCP_SOCKET_TIMINGS = {
  /** `defe2end-mcp` gives up on a call after this long (`timeout`) and sends `cancel`. */
  replyTimeoutMs: 30_000,
  /** A browser op opens the side browser when it is closed, then polls this often, this long (`browser-not-open`). */
  browserOpenPollMs: 250,
  browserOpenWaitMs: 8_000,
  /** click/hover/fill wait this long for a moving element to settle (`element-not-clickable`). */
  elementSettleWaitMs: 2_000,
} as const;

/** Longest accepted line (a 500-step `create_scenario` fits); longer input closes the connection. */
export const MCP_SOCKET_MAX_LINE_BYTES = 4 * 1024 * 1024;

export const MCP_SOCKET_ERROR_CODES = [
  // Browser (the reference list).
  "browser-not-open",
  "tab-not-found",
  "element-not-found",
  "element-not-visible",
  "element-not-clickable",
  "invalid-selector",
  "invalid-args",
  "credential-field",
  "frame-unreachable",
  "last-tab",
  "op-failed",
  "unknown-op",
  // Added by the stage 6 contract.
  "recording-in-progress",
  "scheme-not-allowed",
  /** The screenshot overlay over password/card inputs couldn't be confirmed, or the masking policy couldn't be read. */
  "masking-failed",
  /** Produced by `defe2end-mcp` itself when it can't reach the socket ("open the defE2End app and sign in"). */
  "desktop-not-running",
  // Added here: needed by the relay and by cancellation.
  /** The app isn't signed in, or its MCP token was refused (expired/revoked). */
  "unauthenticated",
  /** Server 403: e.g. a viewer calling a write tool. */
  "forbidden",
  /** Server 404: missing, or in a workspace the user isn't a member of. */
  "not-found",
  /** Server 409 / business refusal (archived scenario, environment change, idempotency clash, missing variables…). */
  "conflict",
  /** The server couldn't be reached or answered 5xx. */
  "server-unavailable",
  /** No reply within `replyTimeoutMs` (set by `defe2end-mcp`). */
  "timeout",
  /** The call was cancelled (`cancel`, connection generation changed, or the app is shutting down). */
  "cancelled",
] as const;
export type McpSocketErrorCode = (typeof MCP_SOCKET_ERROR_CODES)[number];

const callId = z.string().min(1).max(64);
const token = z.string().min(1).max(512);

/** Args per op on the socket: the tool input, plus the idempotency key `defe2end-mcp` adds to run tools. */
export const mcpSocketArgsSchemas = {
  ...mcpToolInputSchemas,
  run_scenario: mcpToolInputSchemas.run_scenario.extend({ idempotencyKey: idempotencyKeySchema }),
  run_steps: mcpToolInputSchemas.run_steps.extend({ idempotencyKey: idempotencyKeySchema }),
} as const satisfies Record<McpToolName, z.ZodType>;
export type McpSocketArgs<T extends McpToolName> = z.infer<(typeof mcpSocketArgsSchemas)[T]>;

/**
 * `op` is any string here so an unknown op gets an `unknown-op` reply instead of a dropped connection;
 * `args` is checked per op with `parseMcpSocketArgs`.
 */
export const mcpSocketCallSchema = z.strictObject({
  type: z.literal("call").optional(),
  id: callId,
  token,
  op: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
  /** The MCP client from `initialize.clientInfo`; the scenario source becomes `mcp:<client>`. */
  client: z.enum(MCP_CLIENTS).optional(),
});
export type McpSocketCall = z.infer<typeof mcpSocketCallSchema>;

export const mcpSocketCancelSchema = z.strictObject({ type: z.literal("cancel"), id: callId, token });
export type McpSocketCancel = z.infer<typeof mcpSocketCancelSchema>;

/**
 * Asks which account the app acts as. The answer's `identity` is `sha256(origin + "\n" + userId)` (hex) — a stable
 * name for "this user on this server" that shows neither — or null while signed out. One connection never changes
 * identity: the app closes all connections when it does.
 */
export const mcpSocketHelloSchema = z.strictObject({ type: z.literal("hello"), id: callId, token });
export type McpSocketHelloRequest = z.infer<typeof mcpSocketHelloSchema>;

export const mcpSocketHelloResultSchema = z.strictObject({ identity: z.string().regex(/^[0-9a-f]{64}$/).nullable() });
export type McpSocketHello = z.infer<typeof mcpSocketHelloResultSchema>;

export const mcpSocketRequestSchema = z.union([mcpSocketCancelSchema, mcpSocketHelloSchema, mcpSocketCallSchema]);
export type McpSocketRequest = z.infer<typeof mcpSocketRequestSchema>;

export const mcpSocketErrorSchema = z.strictObject({
  code: z.enum(MCP_SOCKET_ERROR_CODES),
  message: z.string(),
  /** Names that explain the error, e.g. the missing variable keys of a `conflict`. Never values. */
  keys: z.array(z.string()).optional(),
});
export type McpSocketError = z.infer<typeof mcpSocketErrorSchema>;

export const mcpSocketResponseSchema = z.union([
  z.strictObject({ id: callId, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ id: callId, ok: z.literal(false), error: mcpSocketErrorSchema }),
]);
export type McpSocketResponse = z.infer<typeof mcpSocketResponseSchema>;

/** One message as one line (JSON never contains a raw newline). */
export function encodeMcpSocketLine(message: McpSocketRequest | McpSocketResponse): string {
  return JSON.stringify(message) + "\n";
}

/** Null when the line isn't JSON or isn't a request; the app then closes the connection. */
export function parseMcpSocketRequest(line: string): McpSocketRequest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = mcpSocketRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseMcpSocketResponse(line: string): McpSocketResponse | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = mcpSocketResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type McpSocketArgsCheck = { ok: true; op: McpToolName; args: Record<string, unknown> } | { ok: false; error: McpSocketError };

/** Validates a call's op and args; the error is ready to send back (`unknown-op` / `invalid-args`). */
export function parseMcpSocketArgs(op: string, args: unknown): McpSocketArgsCheck {
  if (!(MCP_TOOL_NAMES as string[]).includes(op)) return { ok: false, error: { code: "unknown-op", message: `Unknown op: ${op.slice(0, 64)}` } };
  const name = op as McpToolName;
  const parsed = (mcpSocketArgsSchemas[name] as z.ZodType<Record<string, unknown>>).safeParse(args);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
    return { ok: false, error: { code: "invalid-args", message } };
  }
  return { ok: true, op: name, args: parsed.data };
}

export function mcpSocketOk(id: string, result: unknown): McpSocketResponse {
  return { id, ok: true, result };
}

export function mcpSocketFail(id: string, code: McpSocketErrorCode, message: string, keys?: string[]): McpSocketResponse {
  return { id, ok: false, error: keys ? { code, message, keys } : { code, message } };
}
