// Stage 6 contract section 7, CLI detection. Electron-free: the user's shell PATH is the source of truth (an app
// started from the Dock doesn't inherit it), every `claude`/`codex` candidate on it answers `--version` within a
// short wait, and the first one that answers wins. A version below the checked range is refused, not warned about.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isSupportedVersion, MIN_VERSION, parseVersion, PROVIDERS, type Provider } from "./versions.js";

export interface CliEntry {
  /** What to spawn. For a Windows npm `.cmd` shim this is the real entry (an `.exe`, or `node` with a script). */
  command: string;
  /** Arguments that go before the provider arguments (the script path when `command` is node). */
  prefixArgs: string[];
}

export type ProviderStatus =
  | { provider: Provider; state: "ready"; version: string; entry: CliEntry }
  | { provider: Provider; state: "unsupported"; version: string; minVersion: string; path: string }
  | { provider: Provider; state: "missing"; candidates: number };

export interface DetectOptions {
  platform?: NodeJS.Platform;
  /** PATH to search; read from the user's shell when omitted. */
  pathValue?: string;
  /** `--version` wait per candidate. Default 1.5 s on macOS/Linux, 15 s on Windows (cold `.cmd` start). */
  versionTimeoutMs?: number;
}

const run = (command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) =>
  new Promise<string | null>((resolve) => {
    execFile(command, args, { timeout: timeoutMs, env: env ?? process.env, windowsHide: true, encoding: "utf8" }, (err, stdout) =>
      resolve(err ? null : String(stdout)),
    );
  });

/** The user's shell PATH: a login+interactive shell on macOS/Linux, User+Machine registry PATH on Windows. */
export async function userShellPath(platform: NodeJS.Platform = process.platform): Promise<string> {
  const own = process.env.PATH ?? "";
  if (platform === "win32") {
    const script = "[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')";
    const out = await run("powershell.exe", ["-NoProfile", "-Command", script], 8000);
    return [out?.trim() ?? "", own].filter(Boolean).join(";");
  }
  const shell = process.env.SHELL || "/bin/zsh";
  const out = await run(shell, ["-ilc", "printf '__PATH__%s' \"$PATH\""], 8000);
  const found = out ? /__PATH__(.*)$/s.exec(out)?.[1]?.trim() : undefined;
  return [found ?? "", own].filter(Boolean).join(":");
}

/** Every executable named `name` on `pathValue`, in PATH order, without duplicates. */
export function findCandidates(name: string, pathValue: string, platform: NodeJS.Platform = process.platform): string[] {
  const sep = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
  const seen = new Set<string>();
  for (const dir of pathValue.split(sep)) {
    if (!dir) continue;
    for (const n of names) {
      const file = (platform === "win32" ? path.win32 : path.posix).join(dir, n);
      if (seen.has(file)) continue;
      try {
        if (statSync(file).isFile()) seen.add(file);
      } catch {
        // not there
      }
    }
  }
  return [...seen];
}

/**
 * The real entry behind a Windows npm `.cmd` shim — spawning a `.cmd` needs a shell, which would re-parse our
 * arguments. The shim names its target relative to `%dp0%`: an `.exe` (native installer layout) or a `.js` run by
 * node. A `.cmd` without such a target is null: Node can't spawn a batch file without a shell (EINVAL), and a shell
 * would re-parse the prompt arguments, so that candidate is skipped.
 */
export function resolveWindowsEntry(file: string, read: (f: string) => string = (f) => readFileSync(f, "utf8")): CliEntry | null {
  if (!file.toLowerCase().endsWith(".cmd")) return { command: file, prefixArgs: [] };
  const dir = path.win32.dirname(file);
  let text = "";
  try {
    text = read(file);
  } catch {
    return null;
  }
  const targets = [...text.matchAll(/"?%~?dp0%?\\?([^"%\r\n]+?\.(?:exe|js|cjs|mjs))"?/gi)].map((m) => path.win32.join(dir, m[1]!));
  const exe = targets.find((t) => t.toLowerCase().endsWith(".exe") && !/\\node\.exe$/i.test(t));
  if (exe) return { command: exe, prefixArgs: [] };
  const script = targets.find((t) => /\.(?:c|m)?js$/i.test(t));
  if (script) {
    const localNode = path.win32.join(dir, "node.exe");
    return { command: existsSync(localNode) ? localNode : "node", prefixArgs: [script] };
  }
  return null;
}

export async function detectProvider(provider: Provider, options: DetectOptions = {}): Promise<ProviderStatus> {
  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? (await userShellPath(platform));
  const timeoutMs = options.versionTimeoutMs ?? (platform === "win32" ? 15_000 : 1_500);
  const env = { ...process.env, PATH: pathValue };
  const candidates = findCandidates(provider, pathValue, platform);
  let unsupported: ProviderStatus | null = null;
  for (const file of candidates) {
    const entry = platform === "win32" ? resolveWindowsEntry(file) : { command: file, prefixArgs: [] };
    if (!entry) continue;
    const out = await run(entry.command, [...entry.prefixArgs, "--version"], timeoutMs, env);
    const version = out ? parseVersion(out) : null;
    if (!version) continue;
    if (isSupportedVersion(provider, version)) return { provider, state: "ready", version, entry };
    unsupported ??= { provider, state: "unsupported", version, minVersion: MIN_VERSION[provider], path: file };
  }
  return unsupported ?? { provider, state: "missing", candidates: candidates.length };
}

export async function detectAll(options: DetectOptions = {}): Promise<ProviderStatus[]> {
  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? (await userShellPath(platform));
  return Promise.all(PROVIDERS.map((p) => detectProvider(p, { ...options, platform, pathValue })));
}
