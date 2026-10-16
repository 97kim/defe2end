// Target-site login sessions made on the PC (stage 4 contract section 5, desktop spec 3.1): the capture
// window and "save this site's login" in the side browser. Values are credentials: logs get counts only.
import type { AuthSessionRegister, AuthSessionTarget, StorageState } from "@defe2end/shared";
import { HttpError, type DesktopApi } from "./api-client.js";

/** Electron's `Cookie` fields we read. */
export interface CookieLike {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
}

export type StorageCookie = StorageState["cookies"][number];

/** Playwright's cookie shape: unspecified SameSite → Lax, session cookies expire -1. */
export function toStorageCookie(c: CookieLike): StorageCookie {
  const sameSite = c.sameSite === "no_restriction" ? "None" : c.sameSite === "strict" ? "Strict" : "Lax";
  return {
    name: c.name,
    value: c.value,
    domain: c.domain ?? "",
    path: c.path ?? "/",
    expires: c.session || c.expirationDate === undefined ? -1 : Math.floor(c.expirationDate),
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite,
  };
}

/** The cookie belongs to `host` itself or one of its parent domains (other sites' sessions stay out). */
export function cookieMatchesHost(cookieDomain: string | undefined, host: string): boolean {
  const domain = (cookieDomain ?? "").replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return !!domain && (h === domain || h.endsWith(`.${domain}`));
}

/**
 * The side browser's "save this site's login": host and parent-domain cookies, and the current origin's
 * localStorage (string pairs). Null when no cookie of the site exists (nothing to save — sign in first).
 */
export function siteStorageState(pageUrl: string, cookies: readonly CookieLike[], localStorage: readonly { name: string; value: string }[] | null): StorageState | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  const own = cookies.filter((c) => cookieMatchesHost(c.domain, url.hostname)).map(toStorageCookie);
  if (own.length === 0) return null;
  const pairs = (localStorage ?? []).filter((e) => typeof e.name === "string" && typeof e.value === "string");
  return { cookies: own, origins: pairs.length ? [{ origin: url.origin, localStorage: pairs }] : [] };
}

/** Page script returning the current origin's localStorage as `[{ name, value }]` (null when unreadable). */
export const READ_LOCAL_STORAGE = `(() => { try { return Object.keys(localStorage).map((name) => ({ name, value: String(localStorage.getItem(name)) })); } catch { return null; } })()`;

export type AuthSessionRegistration = AuthSessionRegister;

/** `POST /api/desktop/auth-sessions`; one retry 2 s later. The owner is the token's user (server side). */
export async function registerAuthSession(api: Pick<DesktopApi, "json">, body: AuthSessionRegistration, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  try {
    await api.json("/api/desktop/auth-sessions", { method: "POST", json: body });
  } catch (err) {
    // A refusal (4xx) won't change on retry.
    if (err instanceof HttpError && err.status >= 400 && err.status < 500) throw err;
    await sleep(2_000);
    await api.json("/api/desktop/auth-sessions", { method: "POST", json: body });
  }
}

/** A visible capture browser (Electron: its own window and in-memory partition). */
export interface CaptureWindow {
  /** Cookies and the current origin's localStorage; null when unreadable. */
  snapshot(): Promise<StorageState | null>;
  /** The window waits for the returned promise (the last snapshot) before it really closes. */
  onClosing(listener: () => Promise<void>): void;
  close(): void;
}

export interface CaptureRequest {
  requestId: string;
  workspaceId: string;
  environmentId: string;
  url: string;
  /** Whose session it is (person, schedule or bot token); returned unchanged on registration. */
  target?: AuthSessionTarget;
}

export interface CaptureControllerOptions {
  open(url: string): CaptureWindow;
  log(message: string): void;
  intervalMs?: number;
}

/** The connection a capture started under: it registers there or nowhere. */
export interface CaptureBinding {
  register(body: AuthSessionRegistration): Promise<void>;
  /** False once the generation changed (logout, server or account change). */
  current(): boolean;
}

export const CAPTURE_SNAPSHOT_MS = 2_500;

interface Capture {
  window: CaptureWindow;
  timer: ReturnType<typeof setInterval>;
  dropped: boolean;
}

/**
 * `capture-auth-state`: the user signs in in a visible browser; a snapshot is taken every 2.5 s and once more
 * when it closes, and the last one with cookies is registered through the connection it started under. A
 * capture stays cancellable until its registration is done: a new request or `stop` (generation change)
 * drops it, and a dropped or stale capture never registers.
 */
export class CaptureController {
  private readonly captures = new Set<Capture>();

  constructor(private readonly opts: CaptureControllerOptions) {}

  start(request: CaptureRequest, binding: CaptureBinding): void {
    this.stop();
    const window = this.opts.open(request.url);
    let last: StorageState | null = null;
    const take = async () => {
      const state = await window.snapshot().catch(() => null);
      if (state && state.cookies.length > 0) last = state;
    };
    const capture: Capture = { window, timer: setInterval(() => void take(), this.opts.intervalMs ?? CAPTURE_SNAPSHOT_MS), dropped: false };
    this.captures.add(capture);
    const live = () => !capture.dropped && binding.current();
    window.onClosing(async () => {
      clearInterval(capture.timer);
      if (!live()) return void this.captures.delete(capture);
      await take();
      void (async () => {
        try {
          if (!live()) return;
          if (!last) {
            this.opts.log("login capture closed without cookies; nothing registered");
            return;
          }
          this.opts.log(`login capture: registering ${last.cookies.length} cookies`);
          await binding.register({ workspaceId: request.workspaceId, environmentId: request.environmentId, requestId: request.requestId, ...(request.target ? { target: request.target } : {}), storageState: last });
        } catch (err) {
          this.opts.log(`login capture registration failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.captures.delete(capture);
        }
      })();
    });
  }

  /** Closes every capture browser, including ones closing or registering, without registering. */
  stop(): void {
    for (const capture of this.captures) {
      capture.dropped = true;
      clearInterval(capture.timer);
      capture.window.close();
    }
    this.captures.clear();
  }
}
