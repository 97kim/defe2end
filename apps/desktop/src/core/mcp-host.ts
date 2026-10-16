// Stage 6 contract sections 5 and 6, Electron side: opens the MCP socket at start, ties its session token to the
// connection (generation, sign-in, account, server), relays domain ops with the MCP token and runs browser ops on
// the side browser. `main.ts` only starts it and stops it; Electron stays outside (the token store is passed in).
import { rm } from "node:fs/promises";
import type { McpToolName } from "@defe2end/shared";
import type { Fetch } from "./api-client.js";
import type { ConnectionState } from "./connection.js";
import { BrowserOps, isBrowserOp, type BrowserDriver } from "./mcp-browser.js";
import { prepareMcpEndpoint, TokenPublisher, type Exec, type McpEndpoint } from "./mcp-endpoint.js";
import { isRelayOp, McpRelay, McpTokenManager, type McpTokenStore } from "./mcp-relay.js";
import { mcpIdentity, McpOpError, McpSocketServer, type McpCallContext } from "./mcp-socket-server.js";

export interface McpHostOptions {
  userData: string;
  installId: string;
  state(): ConnectionState;
  onState(listener: (state: ConnectionState) => void): () => void;
  /** The live generation's desktop token, sent with the MCP token exchange. */
  desktopToken(): string | null;
  fetchWithCookies: Fetch;
  fetch: Fetch;
  driver: BrowserDriver;
  tokenStore: McpTokenStore;
  /**
   * The signed-in identity changed (account, server, sign-out; not on start or a plain reconnect): AI work started
   * for the old one must end — the chat's running turns are stopped here (their `defe2end-mcp` refuses too).
   */
  onIdentityChange?(): void;
  log(message: string): void;
  /** Tests: keychain / DPAPI commands. */
  exec?: Exec;
}

interface Generation {
  key: string;
  identity: string | null;
  controller: AbortController;
  relay: McpRelay | null;
}

export class McpHost {
  private endpoint: McpEndpoint | null = null;
  private server: McpSocketServer | null = null;
  private gen: Generation | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly browser: BrowserOps;
  private publisher: TokenPublisher | null = null;

  constructor(private readonly opts: McpHostOptions) {
    this.browser = new BrowserOps({ driver: opts.driver });
  }

  get tokenStore(): McpTokenStore {
    return this.opts.tokenStore;
  }

  get sessionToken(): string | null {
    return this.server?.sessionToken ?? null;
  }

  /** Waits for session token writes in flight (tests, quit). */
  settled(): Promise<void> {
    return this.publisher?.idle() ?? Promise.resolve();
  }

  get mcpDir(): string | null {
    return this.endpoint?.dir ?? null;
  }

  async start(): Promise<void> {
    this.endpoint = await prepareMcpEndpoint(this.opts.userData, process.platform, this.opts.exec);
    this.publisher = new TokenPublisher(this.endpoint, (code) => this.opts.log(`mcp session token not stored (${code})`));
    this.server = new McpSocketServer({ handle: (op, args, ctx) => this.handle(op, args, ctx), identity: () => this.gen?.identity ?? null, log: this.opts.log });
    await this.server.listen(this.endpoint.address);
    await this.endpoint.secure();
    this.apply(this.opts.state(), true);
    this.unsubscribe = this.opts.onState((state) => this.apply(state, false));
  }

  /** New session token whenever the connection's identity changes (contract 5). */
  private apply(state: ConnectionState, first: boolean): void {
    const signedIn = state.status === "connected" || state.status === "disconnected" || state.status === "connecting";
    const key = [state.generation, state.origin ?? "", signedIn ? (state.userId ?? "") : "", signedIn ? (state.deviceId ?? "") : ""].join("|");
    if (!first && this.gen?.key === key) return;
    this.gen?.controller.abort();
    const controller = new AbortController();
    let relay: McpRelay | null = null;
    if (signedIn && state.origin && state.userId && state.deviceId) {
      const tokens = new McpTokenManager({
        origin: state.origin,
        userId: state.userId,
        deviceId: state.deviceId,
        installId: this.opts.installId,
        store: this.tokenStore,
        fetchWithCookies: this.opts.fetchWithCookies,
        desktopToken: this.opts.desktopToken,
        fetch: this.opts.fetch,
        signal: controller.signal,
        log: this.opts.log,
      });
      relay = new McpRelay({ origin: state.origin, tokens, fetch: this.opts.fetch, deviceId: state.deviceId });
    }
    const before = this.gen?.identity ?? null;
    const identity = relay ? mcpIdentity(state.origin!, state.userId!) : null;
    this.gen = { key, identity, controller, relay };
    this.publisher!.publish(this.server!.rotate());
    if (!first && identity !== before) this.opts.onIdentityChange?.();
  }

  private async handle(op: McpToolName, args: Record<string, unknown>, ctx: McpCallContext): Promise<unknown> {
    const gen = this.gen;
    if (!gen?.relay) throw new McpOpError("unauthenticated", "Open the defE2End app and sign in");
    const signal = AbortSignal.any([ctx.signal, gen.controller.signal]);
    if (isBrowserOp(op)) return this.browser.call(op, args, { ...ctx, signal });
    if (isRelayOp(op)) return gen.relay.call(op, args, { ...ctx, signal });
    throw new McpOpError("unknown-op", `Unknown op: ${op}`);
  }

  /** App logout and server change: the MCP token goes too. */
  clearToken(): Promise<void> {
    return this.opts.tokenStore.clear();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.gen?.controller.abort();
    await this.server?.close();
    if (this.endpoint) {
      // Finish (or drop) writes in flight first, so none lands after the token is cleared.
      await this.publisher?.close();
      await this.endpoint.clearToken().catch(() => {});
      if (process.platform !== "win32") await rm(this.endpoint.address, { force: true });
    }
  }
}
