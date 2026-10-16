// Stage 6 contract section 5: the app side of the local socket `defe2end-mcp` talks to. One JSON request per line,
// validated with the shared protocol; a wrong session token or a malformed line closes the connection without a
// reply. The session token belongs to a connection generation: `rotate()` makes a new one, drops every open
// connection and cancels every call still running. Electron stays out so this runs under plain Node in tests.
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import {
  encodeMcpSocketLine,
  MCP_SOCKET_MAX_LINE_BYTES,
  MCP_SOCKET_TIMINGS,
  mcpSocketFail,
  mcpSocketOk,
  parseMcpSocketArgs,
  parseMcpSocketRequest,
  type McpClient,
  type McpSocketErrorCode,
  type McpSocketResponse,
  type McpToolName,
} from "@defe2end/shared";

/** Thrown by an op handler to answer with a protocol error code. */
export class McpOpError extends Error {
  constructor(
    readonly code: McpSocketErrorCode,
    message: string,
    readonly keys?: string[],
  ) {
    super(message);
    this.name = "McpOpError";
  }
}

export interface McpCallContext {
  signal: AbortSignal;
  client?: McpClient;
}

export type McpOpHandler = (op: McpToolName, args: Record<string, unknown>, ctx: McpCallContext) => Promise<unknown>;

export interface McpSocketServerOptions {
  handle: McpOpHandler;
  /** The `hello` answer: `mcpIdentity(origin, userId)` while signed in, else null. */
  identity?(): string | null;
  /** Default `MCP_SOCKET_TIMINGS.replyTimeoutMs`. */
  replyTimeoutMs?: number;
  log?(message: string): void;
}

class CancelledError extends Error {
  constructor(readonly code: "cancelled" | "timeout") {
    super(code);
  }
}

interface Conn {
  socket: net.Socket;
  calls: Map<string, AbortController>;
}

export class McpSocketServer {
  private server: net.Server | null = null;
  private token: string = newSessionToken();
  private readonly conns = new Set<Conn>();

  constructor(private readonly opts: McpSocketServerOptions) {}

  get sessionToken(): string {
    return this.token;
  }

  /** Listens on a unix socket path or a Windows pipe name. */
  listen(endpoint: string): Promise<void> {
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  /** New generation: new token, every connection closed, every call cancelled. Returns the new token. */
  rotate(): string {
    this.token = newSessionToken();
    for (const conn of [...this.conns]) this.drop(conn);
    return this.token;
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  async close(): Promise<void> {
    for (const conn of [...this.conns]) this.drop(conn);
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private accept(socket: net.Socket): void {
    const conn: Conn = { socket, calls: new Map() };
    this.conns.add(conn);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MCP_SOCKET_MAX_LINE_BYTES && !buffer.includes("\n")) return this.drop(conn);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (!this.onLine(conn, line)) return;
      }
    });
    socket.on("error", () => this.drop(conn));
    socket.on("close", () => this.drop(conn));
  }

  /** False when the connection was dropped. */
  private onLine(conn: Conn, line: string): boolean {
    const request = parseMcpSocketRequest(line);
    if (!request || request.token !== this.token) {
      this.opts.log?.("mcp socket: refused a request (bad line or session token)");
      this.drop(conn);
      return false;
    }
    if (request.type === "cancel") {
      conn.calls.get(request.id)?.abort(new CancelledError("cancelled"));
      return true;
    }
    if (request.type === "hello") {
      this.reply(conn, mcpSocketOk(request.id, { identity: this.opts.identity?.() ?? null }));
      return true;
    }
    if (conn.calls.has(request.id)) {
      this.reply(conn, mcpSocketFail(request.id, "invalid-args", "A call with this id is still running"));
      return true;
    }
    const check = parseMcpSocketArgs(request.op, request.args);
    if (!check.ok) {
      this.reply(conn, { id: request.id, ok: false, error: check.error });
      return true;
    }
    const controller = new AbortController();
    conn.calls.set(request.id, controller);
    void this.run(conn, request.id, check.op, check.args, request.client, controller);
    return true;
  }

  private async run(conn: Conn, id: string, op: McpToolName, args: Record<string, unknown>, client: McpClient | undefined, controller: AbortController): Promise<void> {
    const timer = setTimeout(() => controller.abort(new CancelledError("timeout")), this.opts.replyTimeoutMs ?? MCP_SOCKET_TIMINGS.replyTimeoutMs);
    const aborted = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    aborted.catch(() => {});
    let response: McpSocketResponse;
    try {
      const result = await Promise.race([this.opts.handle(op, args, { signal: controller.signal, ...(client ? { client } : {}) }), aborted]);
      response = mcpSocketOk(id, result);
    } catch (err) {
      response = toFailure(id, err, controller.signal);
    } finally {
      clearTimeout(timer);
      conn.calls.delete(id);
    }
    this.reply(conn, response);
  }

  private reply(conn: Conn, response: McpSocketResponse): void {
    if (!this.conns.has(conn) || conn.socket.destroyed) return;
    conn.socket.write(encodeMcpSocketLine(response));
  }

  private drop(conn: Conn): void {
    if (!this.conns.delete(conn)) return;
    for (const controller of conn.calls.values()) controller.abort(new CancelledError("cancelled"));
    conn.calls.clear();
    conn.socket.destroy();
  }
}

function toFailure(id: string, err: unknown, signal: AbortSignal): McpSocketResponse {
  if (err instanceof McpOpError) return mcpSocketFail(id, err.code, err.message, err.keys);
  const reason = signal.aborted ? signal.reason : err;
  if (reason instanceof CancelledError) return mcpSocketFail(id, reason.code, reason.code === "timeout" ? "No reply in time" : "The call was cancelled");
  return mcpSocketFail(id, "op-failed", err instanceof Error ? err.message.slice(0, 500) : "The operation failed");
}

/** "This user on this server", without showing either (shared `mcpSocketHelloSchema`). */
export function mcpIdentity(origin: string, userId: string): string {
  return createHash("sha256").update(`${origin}\n${userId}`).digest("hex");
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}
