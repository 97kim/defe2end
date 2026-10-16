// Finding the desktop app's socket and its session token (stage 6 contract section 5). The app writes these;
// `defe2end-mcp` only reads them, again on every connection (the token changes with the app's connection generation).
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppEndpoint {
  /** Unix socket path (mac) or named pipe path (Windows). */
  path: string;
  token: string;
}
/** Finds the app now; throws when it isn't there (no socket info, no token). */
export type Connector = () => Promise<AppEndpoint>;

export const KEYCHAIN_SERVICE = "defE2End MCP session";

/** `DEFE2END_MCP_DIR`, else the app data folder's `mcp` folder. */
export function mcpDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.DEFE2END_MCP_DIR) return env.DEFE2END_MCP_DIR;
  if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "defE2End", "mcp");
  return join(homedir(), "Library", "Application Support", "defE2End", "mcp");
}

/** mac: `$DIR/mcp.sock`. Windows: the pipe name written in `$DIR\endpoint.txt` (one line). */
export async function endpointPath(dir: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform !== "win32") return join(dir, "mcp.sock");
  const name = (await readFile(join(dir, "endpoint.txt"), "utf8")).trim();
  if (!name) throw new Error("endpoint.txt is empty");
  return name.startsWith("\\\\") ? name : `\\\\.\\pipe\\${name}`;
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true, env: env ? { ...process.env, ...env } : process.env }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });
}

// The file path goes in through the environment so nothing is quoted into the script.
const UNPROTECT_SCRIPT =
  "Add-Type -AssemblyName System.Security; " +
  "$b = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath $env:DEFE2END_DPAPI_FILE).Trim()); " +
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')))";

/** mac keychain (service + account = DIR), Windows DPAPI CurrentUser (`session.dpapi`, base64). */
export async function readSessionToken(dir: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const raw =
    platform === "win32"
      ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", UNPROTECT_SCRIPT], { DEFE2END_DPAPI_FILE: join(dir, "session.dpapi") })
      : await run("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", dir, "-w"]);
  const token = raw.trim();
  if (!token) throw new Error("No session token");
  return token;
}

/** The real connector; tests swap `readToken` (and point `DEFE2END_MCP_DIR` at a test folder). */
export function createConnector(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; readToken?: (dir: string) => Promise<string> } = {}): Connector {
  const platform = options.platform ?? process.platform;
  const readToken = options.readToken ?? ((dir: string) => readSessionToken(dir, platform));
  return async () => {
    const dir = mcpDir(options.env ?? process.env, platform);
    const path = await endpointPath(dir, platform);
    return { path, token: await readToken(dir) };
  };
}
