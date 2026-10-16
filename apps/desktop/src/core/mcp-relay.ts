// Stage 6 contract sections 2, 3 and 5: the app calls `/api/mcp/*` for `defe2end-mcp` with its own MCP token, so
// the AI-side process never holds a server token. Two parts: the MCP token (issue, store, refresh 7 days before
// expiry — the new token is used only once it is stored) and the op → route table with error code mapping.
// Routes are workspace routes (`/api/mcp/w/{slug}/…`); every domain tool names its `workspaceId`.
import type { McpClient, McpToolName } from "@defe2end/shared";
import type { Fetch } from "./api-client.js";
import { McpOpError, type McpCallContext } from "./mcp-socket-server.js";

export const MCP_TOKEN_REFRESH_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
export const MCP_CLIENT_HEADER = "X-Defe2end-Client";

export interface McpTokenRecord {
  token: string;
  expiresAt: string;
  deviceId: string;
}

export interface McpTokenStoreKey {
  origin: string;
  userId: string;
  deviceId: string;
}

export interface McpTokenStore {
  load(key: McpTokenStoreKey): Promise<McpTokenRecord | null>;
  /** Throws when the secure store can't write; the old token then stays in use. */
  save(key: McpTokenStoreKey, record: McpTokenRecord): Promise<void>;
  clear(): Promise<void>;
}

export interface McpTokenManagerOptions {
  origin: string;
  userId: string;
  deviceId: string;
  installId: string;
  store: McpTokenStore;
  /** Sends the main window's cookies (the issue call is a session-cookie exchange). */
  fetchWithCookies: Fetch;
  /** The live generation's desktop token; the exchange is refused without it. */
  desktopToken(): string | null;
  fetch: Fetch;
  signal: AbortSignal;
  now?(): number;
  log?(message: string): void;
}

/** One generation's MCP token. Issue and refresh are single-flight. */
export class McpTokenManager {
  private record: McpTokenRecord | null = null;
  private loaded = false;
  private pending: Promise<McpTokenRecord> | null = null;

  constructor(private readonly opts: McpTokenManagerOptions) {}

  private get key(): McpTokenStoreKey {
    return { origin: this.opts.origin, userId: this.opts.userId, deviceId: this.opts.deviceId };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** A usable token: loads, issues or refreshes as needed. */
  async token(): Promise<McpTokenRecord> {
    if (!this.loaded) {
      this.loaded = true;
      this.record = await this.opts.store.load(this.key).catch(() => null);
    }
    const current = this.record;
    if (current && Date.parse(current.expiresAt) > this.now()) {
      if (Date.parse(current.expiresAt) - this.now() <= MCP_TOKEN_REFRESH_BEFORE_MS) {
        // Refresh in the background of this call: on any failure keep using the current one.
        await this.single(() => this.refresh(current)).catch((err) => this.opts.log?.(`mcp token refresh failed: ${String(err)}`));
      }
      return this.record ?? current;
    }
    return this.single(() => this.issue());
  }

  /** The server refused the token (401): forget it and issue a new one next time. */
  invalidate(token: string): void {
    if (this.record?.token === token) this.record = null;
  }

  private single(fn: () => Promise<McpTokenRecord>): Promise<McpTokenRecord> {
    this.pending ??= fn().finally(() => (this.pending = null));
    return this.pending;
  }

  private async issue(): Promise<McpTokenRecord> {
    const desktopToken = this.opts.desktopToken();
    if (!desktopToken) throw statusError(401);
    const res = await this.opts.fetchWithCookies(`${this.opts.origin}/api/desktop/mcp-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: this.opts.origin },
      body: JSON.stringify({ installId: this.opts.installId, desktopToken }),
      credentials: "include",
      signal: AbortSignal.any([this.opts.signal, AbortSignal.timeout(10_000)]),
    });
    if (!res.ok) throw statusError(res.status);
    const body = (await res.json()) as { token: string; expiresAt: string; deviceId?: string };
    const record = { token: body.token, expiresAt: body.expiresAt, deviceId: body.deviceId ?? this.opts.deviceId };
    // Issued tokens are usable at once (nothing older to revoke); a failed save only means re-issuing next start.
    await this.opts.store.save(this.key, record).catch((err) => this.opts.log?.(`mcp token not stored: ${String(err)}`));
    this.record = record;
    return record;
  }

  private async refresh(current: McpTokenRecord): Promise<McpTokenRecord> {
    const res = await this.opts.fetch(`${this.opts.origin}/api/mcp/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${current.token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.any([this.opts.signal, AbortSignal.timeout(10_000)]),
    });
    if (!res.ok) throw statusError(res.status);
    const body = (await res.json()) as { token: string; expiresAt: string };
    const next = { token: body.token, expiresAt: body.expiresAt, deviceId: current.deviceId };
    // Contract 3: the first use of the new token revokes the old one, so only switch once it is stored.
    await this.opts.store.save(this.key, next);
    this.record = next;
    return next;
  }
}

/** Server status → socket error code (contract 5). */
export function statusError(status: number, message?: string, keys?: string[]): McpOpError {
  if (status === 401) return new McpOpError("unauthenticated", message ?? "Sign in to the defE2End app again");
  if (status === 403) return new McpOpError("forbidden", message ?? "Not allowed");
  if (status === 404) return new McpOpError("not-found", message ?? "Not found");
  if (status === 409) return new McpOpError("conflict", message ?? "Conflict", keys);
  if (status === 400 || status === 422) return new McpOpError("invalid-args", message ?? "The server refused the input");
  if (status >= 500) return new McpOpError("server-unavailable", message ?? "The server isn't available");
  return new McpOpError("op-failed", message ?? `HTTP ${status}`);
}

export interface RelayOptions {
  origin: string;
  tokens: Pick<McpTokenManager, "token" | "invalidate">;
  fetch: Fetch;
  /** This app's device, for `location: "desktop"` runs. */
  deviceId: string;
}

type Args = Record<string, unknown>;
interface Request {
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Domain ops only (browser ops go to the side browser). */
export const RELAY_OPS = [
  "list_workspaces",
  "list_sites",
  "list_environments",
  "list_scenarios",
  "get_scenario",
  "create_scenario",
  "update_scenario",
  "clone_scenario",
  "run_scenario",
  "run_steps",
  "get_run",
  "list_schedules",
  "create_schedule",
  "update_schedule",
] as const satisfies readonly McpToolName[];
export type RelayOp = (typeof RELAY_OPS)[number];

export function isRelayOp(op: string): op is RelayOp {
  return (RELAY_OPS as readonly string[]).includes(op);
}

const pick = (args: Args, keys: string[]) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

/** One generation's relay. */
export class McpRelay {
  private slugs = new Map<string, string>();

  constructor(private readonly opts: RelayOptions) {}

  async call(op: RelayOp, args: Args, ctx: McpCallContext): Promise<unknown> {
    const call = (req: Request) => this.send(req, ctx);
    if (op === "list_workspaces") return call({ method: "GET", path: "/api/mcp/workspaces" });
    const base = await this.ws(args.workspaceId as string, ctx);
    const scenario = `${base}/scenarios/${enc(args.scenarioId)}`;
    switch (op) {
      case "list_sites":
        return call({ method: "GET", path: `${base}/sites` });
      case "list_environments": {
        const res = (await call({ method: "GET", path: `${base}/sites` })) as { sites: { id: string; environments: unknown[] }[] };
        const sites = args.siteId ? res.sites.filter((s) => s.id === args.siteId) : res.sites;
        return { environments: sites.flatMap((s) => s.environments.map((e) => ({ ...(e as object), siteId: s.id }))) };
      }
      case "list_scenarios":
        return call({ method: "GET", path: `${base}/scenarios`, query: pick(args, ["siteId", "search", "tag", "includeArchived", "limit", "cursor"]) as Request["query"] });
      case "create_scenario":
        return call({ method: "POST", path: `${base}/scenarios`, body: pick(args, ["siteId", "name", "description", "steps", "tags", "retryOnFailure"]) });
      case "get_scenario":
        return call({ method: "GET", path: scenario });
      case "update_scenario":
        // `updatedAt` is what the AI read: a save in between answers 409 (`conflict`) rather than being overwritten.
        return call({ method: "PATCH", path: scenario, body: pick(args, ["updatedAt", "name", "description", "steps", "retryOnFailure"]) });
      case "clone_scenario":
        return call({ method: "POST", path: `${scenario}/duplicate` });
      case "run_scenario":
        return call({
          method: "POST",
          path: `${base}/runs`,
          body: { ...pick(args, ["scenarioId", "environmentId", "location", "options"]), ...this.placement(args) },
          headers: { "Idempotency-Key": args.idempotencyKey as string },
        });
      case "run_steps":
        return call({
          method: "POST",
          path: `${base}/runs/test`,
          body: { ...pick(args, ["environmentId", "steps", "location", "options"]), ...this.placement(args) },
          headers: { "Idempotency-Key": args.idempotencyKey as string },
        });
      case "get_run":
        return call({ method: "GET", path: `${base}/runs/${enc(args.runId)}`, query: { wait: args.wait as number | undefined } });
      case "list_schedules":
        return call({ method: "GET", path: `${base}/schedules` });
      case "create_schedule": {
        const { workspaceId: _w, ...body } = args;
        return call({ method: "POST", path: `${base}/schedules`, body });
      }
      case "update_schedule": {
        const { workspaceId: _w, scheduleId, ...body } = args;
        return call({ method: "PATCH", path: `${base}/schedules/${enc(scheduleId)}`, body });
      }
    }
  }

  private placement(args: Args): Args {
    return args.location === "desktop" ? { deviceId: this.opts.deviceId } : {};
  }

  /** `/api/mcp/w/{slug}` of a workspace id (`GET /api/mcp/workspaces`, remembered for the generation). */
  private async ws(workspaceId: string, ctx: McpCallContext): Promise<string> {
    if (!this.slugs.has(workspaceId)) {
      const res = (await this.send({ method: "GET", path: "/api/mcp/workspaces" }, ctx)) as { workspaces: { id: string; slug: string }[] };
      for (const w of res.workspaces) this.slugs.set(w.id, w.slug);
    }
    const slug = this.slugs.get(workspaceId);
    if (!slug) throw new McpOpError("not-found", "Workspace not found");
    return `/api/mcp/w/${enc(slug)}`;
  }

  private async send(req: Request, ctx: McpCallContext, retried = false): Promise<unknown> {
    let record;
    try {
      record = await this.opts.tokens.token();
    } catch (err) {
      if (err instanceof McpOpError) throw err;
      if (ctx.signal.aborted) throw ctx.signal.reason;
      throw new McpOpError("server-unavailable", "The server isn't available");
    }
    const url = new URL(`${this.opts.origin}${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { ...req.headers, Authorization: `Bearer ${record.token}` };
    const client = clientHeader(ctx.client);
    if (client) headers[MCP_CLIENT_HEADER] = client;
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.opts.fetch(url.toString(), {
        method: req.method,
        headers,
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        redirect: "error",
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      throw new McpOpError("server-unavailable", "The server isn't available");
    }
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (res.status === 401 && !retried) {
      this.opts.tokens.invalidate(record.token);
      return this.send(req, ctx, true);
    }
    if (!res.ok) {
      const err = (body as { error?: { message?: string; keys?: unknown } } | null)?.error;
      const keys = Array.isArray(err?.keys) ? err.keys.filter((k): k is string => typeof k === "string") : undefined;
      throw statusError(res.status, typeof err?.message === "string" ? err.message : undefined, keys);
    }
    return body;
  }
}

function clientHeader(client: McpClient | undefined): string | undefined {
  return client === "claude" || client === "codex" ? client : undefined;
}

const enc = (v: unknown) => encodeURIComponent(String(v));
