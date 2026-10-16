// Stage 6 contract section 7: a provider runs only on a CLI version where the launch limits were seen to hold.
// The range starts at the versions checked on 2026-10-15 (Claude Code 2.1.300, codex-cli 0.162.1); there is no
// upper bound because a newer CLI keeping the same flags is the expected case — the argument tests pin the flags.

export type Provider = "claude" | "codex";
export const PROVIDERS: readonly Provider[] = ["claude", "codex"];

export const MIN_VERSION: Record<Provider, string> = { claude: "2.1.300", codex: "0.162.1" };

/** First `x.y.z` in a `--version` line (`2.1.300 (Claude Code)`, `codex-cli 0.162.1`). */
export function parseVersion(output: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function isSupportedVersion(provider: Provider, version: string): boolean {
  return compareVersions(version, MIN_VERSION[provider]) >= 0;
}
