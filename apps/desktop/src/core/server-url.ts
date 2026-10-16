// Server address entered on first run (stage 4 contract sections 2 and 3.1).

/** Plain `http` only for the local machine; everything else must be HTTPS. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * The origin of what the user typed (no path, no trailing `/`), or null when it isn't an acceptable server
 * address. A bare host gets `https://`.
 */
export function normalizeServerUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  return null;
}

export type ServerCheck = { ok: true; version: string } | { ok: false; reason: "unreachable" | "not_defe2end" };

/** `GET {origin}/api/health` answers like a defE2End server (`status`, `db`, `version`). */
export async function checkServer(origin: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<ServerCheck> {
  let body: unknown;
  try {
    const res = await fetchImpl(`${origin}/api/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    body = await res.json();
  } catch (err) {
    return { ok: false, reason: err instanceof SyntaxError ? "not_defe2end" : "unreachable" };
  }
  if (typeof body !== "object" || body === null) return { ok: false, reason: "not_defe2end" };
  const health = body as Record<string, unknown>;
  const looksRight = (health.status === "ok" || health.status === "error") && typeof health.db === "string" && typeof health.version === "string";
  return looksRight ? { ok: true, version: health.version as string } : { ok: false, reason: "not_defe2end" };
}
