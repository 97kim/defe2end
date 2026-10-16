// One connection generation's worth of wiring (stage 4 contract sections 3, 4 and 9): token, stream, outbox and
// run queue, plus the ordered teardown on logout, server change and account change. Electron stays behind
// `Platform` so the order is tested without it.
import type { RunPlanOptions } from "@defe2end/runner";
import type { AppUpdateRequired, DesktopStreamMessage, ExecutionPlan, RunVerdict } from "@defe2end/shared";
import { DesktopApi, exchangeToken, HttpError, type DesktopIdentity, type Fetch } from "./api-client.js";
import { RunExecutor, type RunProgress } from "./executor.js";
import { Generations, type GenerationTicket } from "./generation.js";
import { Outbox, sendCompletion } from "./outbox.js";
import { SseClient, type StreamStatus } from "./sse.js";

export interface Platform {
  /** Sends the main window session's cookies (Electron: the default session's `fetch`). */
  fetchWithCookies: Fetch;
  fetch: Fetch;
  loadToken(origin: string): Promise<DesktopIdentity | null>;
  saveToken(origin: string, identity: DesktopIdentity): Promise<void>;
  clearToken(): Promise<void>;
  /** The web UI's own sign-out API, so the cookies can't be exchanged again. */
  webLogout(origin: string): Promise<void>;
  clearServerCookies(origin: string): Promise<void>;
  /** `persist:defe2end-target`: the next user must not inherit target-site logins. */
  clearSideBrowser(): Promise<void>;
  /** Stops a login capture browser if one is open. */
  stopCaptures(): Promise<void>;
  runPlan(plan: ExecutionPlan, opts: RunPlanOptions): Promise<RunVerdict>;
  onUpdateRequired(body: AppUpdateRequired): void;
  onStreamMessage?(message: DesktopStreamMessage): void;
  log(message: string): void;
}

export interface ConnectionConfig {
  appVersion: string;
  runnerVersion: string;
  installId: string;
  label: string;
  dataDir: string;
  ownerMark: string;
  sandbox: boolean;
  executablePath?: string;
  /** The "hide the browser" setting, read at each run's start. */
  headless?(): boolean;
}

export type ConnectionStatus = "no_server" | "signed_out" | "connecting" | "connected" | "disconnected" | "update_required";

export interface ConnectionState {
  status: ConnectionStatus;
  origin: string | null;
  userId: string | null;
  deviceId: string | null;
  generation: number;
}

export type TeardownReason = "logout" | "server_change" | "account_change";

/** Teardown steps in contract section 9 order; tests assert this list. */
export const TEARDOWN_STEPS = ["stream", "runs", "requests", "revoke", "token", "cookies", "side_browser", "generation"] as const;

interface Live {
  ticket: GenerationTicket;
  api: DesktopApi;
  outbox: Outbox;
  executor: RunExecutor;
  sse: SseClient;
}

export class ConnectionManager {
  private readonly generations = new Generations();
  private origin: string | null;
  private live: Live | null = null;
  private connecting: Promise<void> | null = null;
  private tearingDown: Promise<void> | null = null;
  /** Set synchronously when a teardown begins, so a connect in flight never installs itself afterwards. */
  private closing = false;
  /** The API client of a connect still in flight (its token is revoked too if a teardown comes first). */
  private pendingApi: DesktopApi | null = null;
  private status: ConnectionStatus;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private readonly runListeners = new Set<(progress: RunProgress) => void>();

  constructor(
    private readonly platform: Platform,
    private readonly config: ConnectionConfig,
    origin: string | null,
  ) {
    this.origin = origin;
    this.status = origin ? "signed_out" : "no_server";
  }

  get state(): ConnectionState {
    const identity = this.live?.api.current ?? null;
    return { status: this.status, origin: this.origin, userId: identity?.userId ?? null, deviceId: identity?.deviceId ?? null, generation: this.generations.ticket().id };
  }

  /** The live generation's desktop token (the MCP token exchange proves the device generation with it). */
  get desktopToken(): string | null {
    return this.live?.api.current?.token ?? null;
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onRun(listener: (progress: RunProgress) => void): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const l of this.listeners) l(this.state);
  }

  /** After sign-in (the main window reached a signed-in server page). Single-flight. */
  connect(): Promise<void> {
    if (!this.origin || this.closing) return Promise.resolve();
    if (this.live) return Promise.resolve();
    this.connecting ??= this.doConnect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const origin = this.origin!;
    const ticket = this.generations.ticket();
    const { platform, config } = this;
    this.setStatus("connecting");
    const api = new DesktopApi({
      origin,
      ticket,
      identity: await platform.loadToken(origin),
      exchange: (signal) => exchangeToken(origin, { installId: config.installId, label: config.label }, platform.fetchWithCookies, signal),
      // A token that arrives after a teardown began must not land in the secure store.
      // A token that arrives after a teardown began must not land in the secure store; revoke it instead.
      onIdentity: async (identity) => {
        if (ticket.current() && !this.closing) await platform.saveToken(origin, identity);
        else void this.revoke(origin, identity.token);
      },
      onDiscarded: (token) => void this.revoke(origin, token),
      fetchImpl: platform.fetch,
      appVersion: config.appVersion,
      runnerVersion: config.runnerVersion,
    });
    this.pendingApi = api;
    try {
      await api.ensureIdentity();
    } catch (err) {
      if (!ticket.current() || this.closing) return;
      platform.log(`connect: no token (${err instanceof HttpError ? `HTTP ${err.status}` : err instanceof Error ? err.message : String(err)})`);
      this.setStatus("signed_out");
      return;
    }
    if (!ticket.current() || this.closing) return;
    const owner = () => (api.current ? { userId: api.current.userId, deviceId: api.current.deviceId } : null);
    let executor: RunExecutor;
    const outbox = new Outbox({
      rootDir: config.dataDir,
      origin,
      owner,
      send: (entry) => sendCompletion(api, entry),
      onSettled: (runId) => {
        executor.settled(runId);
        executor.pump();
      },
      log: platform.log,
    });
    executor = new RunExecutor({
      api,
      ticket,
      owner,
      report: (runId, o, body, secrets) => outbox.add(runId, o, body, secrets),
      pendingReports: () => outbox.pendingRunIds().length,
      runPlan: platform.runPlan,
      ownerMark: config.ownerMark,
      ...(config.executablePath ? { executablePath: config.executablePath } : {}),
      ...(config.headless ? { headless: config.headless } : {}),
      sandbox: config.sandbox,
      onProgress: (p) => {
        for (const l of this.runListeners) l(p);
      },
      log: platform.log,
    });
    await outbox.load();
    if (!ticket.current() || this.closing) return outbox.close();
    const sse = new SseClient({
      api,
      ticket,
      activeRuns: () => [...new Set([...executor.activeRunIds(), ...outbox.pendingRunIds()])],
      onMessage: (message) => this.dispatch(message),
      onUpdateRequired: (body) => {
        this.setStatus("update_required");
        platform.onUpdateRequired(body);
      },
      onAccountChanged: () => void this.teardown("account_change"),
      onStatus: (s: StreamStatus) => {
        if (s === "connecting" || s === "connected" || s === "disconnected") this.setStatus(s === "connecting" ? "connecting" : s);
      },
      log: platform.log,
    });
    // Checked once more right before installing: a teardown may have started during any await above.
    if (!ticket.current() || this.closing) return outbox.close();
    this.live = { ticket, api, outbox, executor, sse };
    this.pendingApi = null;
    sse.start();
  }

  private dispatch(message: DesktopStreamMessage): void {
    const live = this.live;
    if (!live) return;
    switch (message.type) {
      case "connected":
        void live.outbox.flush();
        break;
      case "run":
        live.executor.enqueue(message);
        break;
      case "stop-run":
        live.executor.stop(message.runId);
        break;
      case "heartbeat":
        break;
    }
    this.platform.onStreamMessage?.(message);
  }

  /**
   * Contract section 9: stream → runs and captures (5 s) → in-flight requests → revoke on the old server (2 s,
   * best effort) → stored token → server cookies (web sign-out first on logout) → side browser data → new generation.
   * Results of stopped runs are never sent.
   */
  teardown(reason: TeardownReason, onStep?: (step: (typeof TEARDOWN_STEPS)[number]) => void): Promise<void> {
    this.tearingDown ??= this.doTeardown(reason, onStep).finally(() => (this.tearingDown = null));
    return this.tearingDown;
  }

  private async doTeardown(reason: TeardownReason, onStep?: (step: (typeof TEARDOWN_STEPS)[number]) => void): Promise<void> {
    const step = (s: (typeof TEARDOWN_STEPS)[number]) => onStep?.(s);
    this.closing = true;
    try {
      await this.runTeardown(reason, step);
    } finally {
      this.closing = false;
    }
  }

  private async runTeardown(reason: TeardownReason, step: (s: (typeof TEARDOWN_STEPS)[number]) => void): Promise<void> {
    const { platform } = this;
    const live = this.live;
    const pending = this.pendingApi;
    this.live = null;
    this.pendingApi = null;
    const origin = this.origin;
    const token = live?.api.current?.token ?? pending?.current?.token ?? (origin ? (await platform.loadToken(origin))?.token : undefined);

    live?.sse.stop();
    step("stream");
    await Promise.all([live?.executor.shutdown(5_000), platform.stopCaptures().catch(() => {})]);
    step("runs");
    live?.outbox.close();
    this.generations.next();
    step("requests");
    if (origin && token) {
      await this.revoke(origin, token);
    }
    step("revoke");
    await platform.clearToken();
    step("token");
    if (origin) {
      if (reason === "logout") await platform.webLogout(origin).catch((err) => platform.log(`web sign-out failed: ${String(err)}`));
      await platform.clearServerCookies(origin);
    }
    step("cookies");
    await platform.clearSideBrowser();
    step("side_browser");
    this.setStatus(this.origin ? "signed_out" : "no_server");
    step("generation");
  }

  /** `DELETE /api/desktop/token` with the token itself (2 s, best effort); the outcome is logged without it. */
  private async revoke(origin: string, token: string): Promise<void> {
    try {
      const res = await this.platform.fetch(`${origin}/api/desktop/token`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, Origin: origin }, signal: AbortSignal.timeout(2_000) });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) this.platform.log(`token revoke refused: HTTP ${res.status}`);
    } catch (err) {
      this.platform.log(`token revoke failed: ${err instanceof Error ? err.name : "error"}`);
    }
  }

  /** Server change: tear the old one down, then remember the new origin (the caller loads its web UI). */
  async changeServer(origin: string | null): Promise<void> {
    await this.teardown("server_change");
    this.origin = origin;
    this.setStatus(origin ? "signed_out" : "no_server");
  }

  /** The current generation's API client (registrations from the app), or null while not connected. */
  get api(): DesktopApi | null {
    return this.live?.api ?? null;
  }

  get serverOrigin(): string | null {
    return this.origin;
  }

  /** Quit: stop runs within the budget; stored completions stay on disk for next time. */
  async quit(budgetMs = 5_000): Promise<void> {
    const live = this.live;
    if (!live) return;
    live.sse.stop();
    await live.executor.shutdown(budgetMs);
    live.outbox.close();
  }
}

