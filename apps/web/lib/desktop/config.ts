// `GET /api/desktop/config` (stage 4 contract section 3.1): origins the app's main window may visit to sign in.
import { DESKTOP_MIN_VERSION_DEFAULT } from "@defe2end/shared";

let discovered: { url: string; origins: string[] } | undefined;

function originOf(url: string | undefined): string[] {
  if (!url) return [];
  try {
    return [new URL(url).origin];
  } catch {
    return [];
  }
}

/** OIDC discovery's authorization endpoint and issuer, fetched once per discovery URL. */
async function oidcOrigins(discoveryUrl: string): Promise<string[]> {
  if (discovered?.url === discoveryUrl) return discovered.origins;
  const origins = new Set<string>();
  try {
    const res = await fetch(discoveryUrl, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      const doc = (await res.json()) as { authorization_endpoint?: string; issuer?: string };
      for (const o of [...originOf(doc.authorization_endpoint), ...originOf(doc.issuer)]) origins.add(o);
      discovered = { url: discoveryUrl, origins: [...origins] };
    }
  } catch {
    // Not cached: the next request tries again. The issuer origin below still goes out.
  }
  for (const o of originOf(discoveryUrl)) origins.add(o);
  return [...origins];
}

export async function allowedAuthOrigins(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const origins = new Set<string>();
  if (env.OIDC_DISCOVERY_URL && env.OIDC_CLIENT_ID) for (const o of await oidcOrigins(env.OIDC_DISCOVERY_URL)) origins.add(o);
  if (env.GITHUB_CLIENT_ID) origins.add("https://github.com");
  for (const raw of (env.DESKTOP_EXTRA_AUTH_ORIGINS ?? "").split(",")) for (const o of originOf(raw.trim() || undefined)) origins.add(o);
  return [...origins];
}

/** `DESKTOP_MIN_VERSION`, else the shared default. */
export function desktopMinVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.DESKTOP_MIN_VERSION?.trim() || DESKTOP_MIN_VERSION_DEFAULT;
}
