// New-version notice (stage 8 contract section 1): 60 seconds after start and then once a day, asks the public
// releases API for the latest published (non-pre-release) version. The request carries no credentials, server
// address or user identifier; a failure or a slow answer (5 seconds) is ignored until the next check.
import { compareVersions } from "@defe2end/shared";

export const LATEST_RELEASE_URL = "https://api.github.com/repos/97kim/defe2end/releases/latest";
export const RELEASES_PAGE = "https://github.com/97kim/defe2end/releases/";
export const FIRST_CHECK_MS = 60_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const TIMEOUT_MS = 5_000;

export interface AvailableUpdate {
  version: string;
  url: string;
}

/** The release worth a notice, or null: only a newer, published, non-pre-release `vX.Y.Z` on the releases page. */
export function newerRelease(current: string, release: unknown): AvailableUpdate | null {
  if (!release || typeof release !== "object") return null;
  const r = release as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (r.draft === true || r.prerelease === true || typeof r.tag_name !== "string") return null;
  const m = /^v(\d+\.\d+\.\d+)$/.exec(r.tag_name);
  if (!m) return null;
  const version = m[1]!;
  if (compareVersions(version, current) <= 0) return null;
  const url = typeof r.html_url === "string" && r.html_url.startsWith(RELEASES_PAGE) ? r.html_url : `${RELEASES_PAGE}tag/${r.tag_name}`;
  return { version, url };
}

export async function checkForUpdate(current: string, fetchImpl: typeof fetch = fetch): Promise<AvailableUpdate | null> {
  try {
    const res = await fetchImpl(LATEST_RELEASE_URL, {
      headers: { accept: "application/vnd.github+json" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return newerRelease(current, await res.json());
  } catch {
    return null;
  }
}

/**
 * Runs `check` after FIRST_CHECK_MS and then every CHECK_INTERVAL_MS while `enabled()` says so (read at each
 * tick, so turning the notice off before the first check stops it). Returns a stop function.
 */
export function scheduleUpdateChecks(enabled: () => boolean, check: () => Promise<void>, timers = { setTimeout, setInterval, clearTimeout, clearInterval }): () => void {
  const tick = () => {
    if (enabled()) void check().catch(() => undefined);
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = timers.setTimeout(() => {
    tick();
    interval = timers.setInterval(tick, CHECK_INTERVAL_MS);
  }, FIRST_CHECK_MS);
  return () => {
    timers.clearTimeout(first);
    if (interval) timers.clearInterval(interval);
  };
}
