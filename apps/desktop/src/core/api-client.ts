// Authenticated calls to the server's desktop API (stage 4 contract section 3.1, desktop spec 1.2).
import { DESKTOP_CAPABILITIES, DESKTOP_HEADERS, DESKTOP_PROTOCOL_VERSION, desktopTokenResponseSchema, formatDesktopClientHeader, type DesktopTokenRequest, type DesktopTokenResponse } from "@defe2end/shared";
import type { GenerationTicket } from "./generation.js";

export type Fetch = typeof fetch;

export interface DesktopIdentity {
  token: string;
  userId: string;
  deviceId: string;
  expiresAt: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }
}

/** The exchange returned another user's token: it must not reach the connection of the old one. */
export class AccountChangedError extends Error {
  constructor() {
    super("The signed-in account changed");
    this.name = "AccountChangedError";
  }
}

/**
 * `POST {origin}/api/desktop/token` with the server cookies of the main window's session. `fetchImpl` is
 * expected to send those cookies (Electron: the default session's `fetch`).
 */
export async function exchangeToken(origin: string, body: DesktopTokenRequest, fetchImpl: Fetch, signal?: AbortSignal): Promise<DesktopTokenResponse> {
  const res = await fetchImpl(`${origin}/api/desktop/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
    credentials: "include",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new HttpError(res.status, await readBody(res));
  return desktopTokenResponseSchema.parse(await res.json());
}

export interface ApiRequest {
  method?: string;
  headers?: Record<string, string>;
  /** A factory so the request can be sent again after a 401 (a stream can be read only once). */
  body?: () => BodyInit;
  /** Per request, default 10 s; 0 = none (the stream). The generation's signal is always added. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DesktopApiOptions {
  origin: string;
  ticket: GenerationTicket;
  /** A token from the secure store, if any. */
  identity: DesktopIdentity | null;
  exchange(signal: AbortSignal): Promise<DesktopTokenResponse>;
  /** Called with every new token (the caller keeps it in `safeStorage`). */
  onIdentity(identity: DesktopIdentity): void | Promise<void>;
  /** A token the server issued after this generation ended: never used, the caller revokes it. */
  onDiscarded?(token: string): void;
  fetchImpl?: Fetch;
  appVersion: string;
  runnerVersion: string;
}

/**
 * One generation's API client. Exchanges are single-flight: many concurrent 401s share one exchange, and a
 * late 401 of a request sent with an older token just uses the newer one. A request is resent once after 401;
 * 403 goes back to the caller as is.
 */
export class DesktopApi {
  readonly origin: string;
  private identity: DesktopIdentity | null;
  private exchanging: Promise<DesktopIdentity> | null = null;
  private readonly fetchImpl: Fetch;

  constructor(private readonly opts: DesktopApiOptions) {
    this.origin = opts.origin;
    this.identity = opts.identity;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Still the generation this client was made for. */
  isCurrent(): boolean {
    return this.opts.ticket.current();
  }

  get current(): DesktopIdentity | null {
    return this.identity;
  }

  get clientHeaders(): Record<string, string> {
    return {
      [DESKTOP_HEADERS.client]: formatDesktopClientHeader({ app: this.opts.appVersion, runner: this.opts.runnerVersion, protocol: DESKTOP_PROTOCOL_VERSION }),
      [DESKTOP_HEADERS.capabilities]: DESKTOP_CAPABILITIES.join(","),
    };
  }

  /** A token, exchanging one when there is none. */
  async ensureIdentity(): Promise<DesktopIdentity> {
    return this.identity ?? this.refresh(null);
  }

  /**
   * New token unless one newer than `stale` already exists. Throws `AccountChangedError` when the server
   * answers for another user than the one this generation started with.
   */
  refresh(stale: string | null): Promise<DesktopIdentity> {
    if (this.identity && this.identity.token !== stale) return Promise.resolve(this.identity);
    this.exchanging ??= (async () => {
      try {
        const res = await this.opts.exchange(this.opts.ticket.signal);
        if (!this.opts.ticket.current()) {
          this.opts.onDiscarded?.(res.token);
          throw this.opts.ticket.signal.reason ?? new Error("The connection changed");
        }
        const before = this.identity;
        if (before && (before.userId !== res.userId || before.deviceId !== res.deviceId)) throw new AccountChangedError();
        const next: DesktopIdentity = { token: res.token, userId: res.userId, deviceId: res.deviceId, expiresAt: res.expiresAt };
        this.identity = next;
        await this.opts.onIdentity(next);
        return next;
      } finally {
        this.exchanging = null;
      }
    })();
    return this.exchanging;
  }

  /** Sends with `Authorization: Bearer`; one exchange and resend on 401. */
  async request(path: string, req: ApiRequest = {}): Promise<Response> {
    let identity = await this.ensureIdentity();
    let res = await this.send(path, req, identity.token);
    if (res.status !== 401) return res;
    await res.body?.cancel().catch(() => {});
    identity = await this.refresh(identity.token);
    res = await this.send(path, req, identity.token);
    return res;
  }

  private send(path: string, req: ApiRequest, token: string): Promise<Response> {
    const timeoutMs = req.timeoutMs ?? 10_000;
    const signals = [this.opts.ticket.signal];
    if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
    if (req.signal) signals.push(req.signal);
    const body = req.body?.();
    return this.fetchImpl(`${this.origin}${path}`, {
      method: req.method ?? "GET",
      headers: { ...this.clientHeaders, ...req.headers, Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body, duplex: "half" }),
      redirect: "error",
      signal: AbortSignal.any(signals),
    } as RequestInit);
  }

  /** JSON helper: 2xx → parsed body, otherwise `HttpError` with the parsed body. */
  async json(path: string, req: ApiRequest & { json?: unknown } = {}): Promise<unknown> {
    const { json, ...rest } = req;
    const res = await this.request(path, {
      ...rest,
      ...(json === undefined ? {} : { body: () => JSON.stringify(json), headers: { "Content-Type": "application/json", ...rest.headers } }),
    });
    const body = await readBody(res);
    if (!res.ok) throw new HttpError(res.status, body);
    return body;
  }
}

export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
