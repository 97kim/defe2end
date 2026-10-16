// Who may call the app, and where the main window may go (stage 4 contract section 8). Electron-free so the
// rules are tested on their own; main.ts feeds them the sender frame and window facts.

export interface SenderFacts {
  /** The IPC came from the main window's webContents. */
  fromMainWindow: boolean;
  /** `senderFrame` is the top frame of that webContents. */
  isMainFrame: boolean;
  /** `senderFrame.url`; may be empty when the frame is gone. */
  frameUrl: string;
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? null : parsed.origin;
  } catch {
    return null;
  }
}

/** Every handler except `setup`: the main window's top frame showing the saved server origin. */
export function isServerSender(sender: SenderFacts, serverOrigin: string | null): boolean {
  return !!serverOrigin && sender.fromMainWindow && sender.isMainFrame && originOf(sender.frameUrl) === serverOrigin;
}

/** `setup` only: the main window's top frame showing exactly the bundled first-run page (query and hash ignored). */
export function isSetupSender(sender: SenderFacts, setupPageUrl: string): boolean {
  if (!sender.fromMainWindow || !sender.isMainFrame) return false;
  try {
    const a = new URL(sender.frameUrl);
    const b = new URL(setupPageUrl);
    return a.protocol === "file:" && a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

export type NavigationDecision = "allow" | "external" | "block";

/**
 * Main window navigation: the server origin and the allowed sign-in origins stay inside; other http(s) links
 * open in the system browser; every other scheme is refused.
 */
export function mainWindowNavigation(target: string, serverOrigin: string | null, authOrigins: readonly string[]): NavigationDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "block";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "block";
  if (serverOrigin && (url.origin === serverOrigin || authOrigins.includes(url.origin))) return "allow";
  return "external";
}

/** Keeps only well-formed http(s) origins from `/api/desktop/config`. */
export function parseAuthOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (typeof v !== "string") return [];
    const origin = originOf(v);
    return origin && /^https?:/.test(origin) && origin === v.replace(/\/$/, "") ? [origin] : [];
  });
}
