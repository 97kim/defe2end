// The client side of the desktop socket (shared `mcp-socket.ts`): one connection reused across calls, `cancel` on
// abort or timeout, one reconnect before `desktop-not-running`. Each new connection reads the session token again
// (an app restart or reconnect makes a new one) and asks `hello` who is signed in. The first signed-in identity is
// pinned: if a later connection answers another one (other account or server), this process — started for the old
// one — must not carry on as the new one, so every call ends with `unauthenticated`.
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  encodeMcpSocketLine,
  mcpSocketHelloResultSchema,
  MCP_SOCKET_TIMINGS,
  parseMcpSocketResponse,
  type McpClient,
  type McpSocketError,
  type McpSocketErrorCode,
} from "@defe2end/shared";
import type { Connector } from "./locate.js";

export type CallOutcome = { ok: true; result: unknown } | { ok: false; error: McpSocketError };

export interface CallOptions {
  client: McpClient;
  signal?: AbortSignal;
  /** Resend after the connection dropped (safe for idempotent tools only). */
  retryOnDrop: boolean;
  /** Resend after a timeout (run tools: the same idempotency key returns the same run). */
  retryOnTimeout: boolean;
}

export const DESKTOP_NOT_RUNNING_MESSAGE = "defE2End 앱을 켜고 로그인하세요";
export const CONNECTION_CHANGED_MESSAGE = "로그인이 바뀌었어요. AI 대화를 새로 시작하세요.";
const CONNECT_TIMEOUT_MS = 3_000;
/** `hello` is answered at once by a live app. */
const HELLO_TIMEOUT_MS = 3_000;

const fail = (code: McpSocketErrorCode, message: string): CallOutcome => ({ ok: false, error: { code, message } });

type SendOutcome = { kind: "reply"; outcome: CallOutcome } | { kind: "dropped" } | { kind: "timeout" } | { kind: "aborted" };

class Connection {
  private buffer = "";
  private readonly pending = new Map<string, (o: SendOutcome) => void>();
  alive = true;

  constructor(
    private readonly socket: Socket,
    readonly token: string,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const response = parseMcpSocketResponse(line);
      if (!response) continue;
      const settle = this.pending.get(response.id);
      if (!settle) continue;
      settle({ kind: "reply", outcome: response.ok ? { ok: true, result: response.result } : { ok: false, error: response.error } });
    }
  }

  close() {
    if (!this.alive) return;
    this.alive = false;
    this.socket.destroy();
    for (const settle of [...this.pending.values()]) settle({ kind: "dropped" });
  }

  /** The app's signed-in identity (null: signed out); undefined when the app didn't answer properly. */
  hello(timeoutMs: number): Promise<string | null | undefined> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
      const settle = (o: SendOutcome) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        if (o.kind !== "reply" || !o.outcome.ok) return resolve(undefined);
        const parsed = mcpSocketHelloResultSchema.safeParse(o.outcome.result);
        resolve(parsed.success ? parsed.data.identity : undefined);
      };
      this.pending.set(id, settle);
      this.socket.write(encodeMcpSocketLine({ type: "hello", id, token: this.token }));
    });
  }

  send(op: string, args: Record<string, unknown>, client: McpClient, timeoutMs: number, signal?: AbortSignal): Promise<SendOutcome> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const cancel = () => {
        if (this.alive) this.socket.write(encodeMcpSocketLine({ type: "cancel", id, token: this.token }));
      };
      const onAbort = () => {
        cancel();
        settle({ kind: "aborted" });
      };
      const timer = setTimeout(() => {
        cancel();
        settle({ kind: "timeout" });
      }, timeoutMs);
      const settle = (o: SendOutcome) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(o);
      };
      this.pending.set(id, settle);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.socket.write(encodeMcpSocketLine({ type: "call", id, token: this.token, op, args, client }));
    });
  }
}

export class AppSocketClient {
  private connection: Connection | null = null;
  private connecting: Promise<Connection | null> | null = null;
  /** The account this process belongs to; set by the first signed-in `hello`. */
  private pinnedIdentity: string | null = null;
  /** The app is signed in as someone else now: every call fails from now on. */
  private stale = false;

  constructor(
    private readonly connector: Connector,
    private readonly timeoutMs: number = MCP_SOCKET_TIMINGS.replyTimeoutMs,
  ) {}

  private async open(): Promise<Connection | null> {
    try {
      const { path, token } = await this.connector();
      const socket = await new Promise<Socket>((resolve, reject) => {
        const s = createConnection(path);
        const timer = setTimeout(() => {
          s.destroy();
          reject(new Error("connect timeout"));
        }, CONNECT_TIMEOUT_MS);
        s.once("connect", () => {
          clearTimeout(timer);
          resolve(s);
        });
        s.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      const conn = new Connection(socket, token);
      const identity = await conn.hello(Math.min(HELLO_TIMEOUT_MS, this.timeoutMs));
      if (identity === undefined) {
        conn.close();
        return null;
      }
      if (identity !== null) {
        this.pinnedIdentity ??= identity;
        if (identity !== this.pinnedIdentity) {
          this.stale = true;
          conn.close();
          return null;
        }
      }
      return conn;
    } catch {
      return null;
    }
  }

  /** A live connection: the current one, or a new one (one retry), or null when the app can't be reached. */
  private async connect(): Promise<Connection | null> {
    if (this.connection?.alive) return this.connection;
    this.connecting ??= (async () => {
      const conn = (await this.open()) ?? (await this.open());
      this.connection = conn;
      return conn;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * One tool call within `timeoutMs` in total — connecting, `hello`, the call and any retry share the budget — and
   * ended at once by `options.signal`. A shared connect in progress keeps going for other calls; this one stops
   * waiting for it.
   */
  async call(op: string, args: Record<string, unknown>, options: CallOptions): Promise<CallOutcome> {
    const deadline = Date.now() + this.timeoutMs;
    const timedOut = () => fail("timeout", `No reply from the defE2End app within ${Math.round(this.timeoutMs / 1000)} seconds`);
    const cancelled = () => fail("cancelled", "The call was cancelled");
    /** The connection, or why not; resolves early on cancel or when the budget runs out. */
    const connect = async (): Promise<Connection | null | "cancelled" | "timeout"> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "timeout";
      return new Promise((resolve) => {
        const timer = setTimeout(() => done("timeout"), remaining);
        const onAbort = () => done("cancelled");
        const done = (v: Connection | null | "cancelled" | "timeout") => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolve(v);
        };
        if (options.signal?.aborted) return done("cancelled");
        options.signal?.addEventListener("abort", onAbort, { once: true });
        void this.connect().then(done, () => done(null));
      });
    };
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) return cancelled();
      if (this.stale) return fail("unauthenticated", CONNECTION_CHANGED_MESSAGE);
      const conn = await connect();
      if (this.stale) return fail("unauthenticated", CONNECTION_CHANGED_MESSAGE);
      if (conn === "cancelled") return cancelled();
      if (conn === "timeout") return timedOut();
      if (!conn) return fail("desktop-not-running", DESKTOP_NOT_RUNNING_MESSAGE);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return timedOut();
      // A call that may be resent after a timeout gets half the budget first, so the resend fits too.
      const wait = options.retryOnTimeout && attempt === 0 ? Math.floor(remaining / 2) : remaining;
      const sent = await conn.send(op, args, options.client, wait, options.signal);
      switch (sent.kind) {
        case "reply":
          return sent.outcome;
        case "aborted":
          return cancelled();
        case "timeout":
          if (options.retryOnTimeout && attempt === 0 && deadline - Date.now() > 0) continue;
          return timedOut();
        case "dropped": {
          if (options.retryOnDrop && attempt === 0) continue;
          // The app cancels calls of a closed connection; say whether it is still there.
          const again = await connect();
          if (this.stale) return fail("unauthenticated", CONNECTION_CHANGED_MESSAGE);
          if (again === "cancelled") return cancelled();
          if (!again || again === "timeout") return fail("desktop-not-running", DESKTOP_NOT_RUNNING_MESSAGE);
          return fail("cancelled", "The connection to the defE2End app closed and the call was cancelled. Check the result before calling again.");
        }
      }
    }
  }

  close() {
    this.connection?.close();
    this.connection = null;
  }
}
