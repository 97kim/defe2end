// Stage 6 contract section 5: where the socket lives and how its session token reaches `defe2end-mcp`. The names
// are fixed — the MCP side reads the same ones:
//   DIR = <userData>/mcp (0700)
//   mac/linux: unix socket DIR/mcp.sock (0600); token in the keychain, service "defE2End MCP session", account DIR
//   Windows: named pipe whose name is in DIR\endpoint.txt; token in DIR\session.dpapi (base64 of DPAPI CurrentUser)
// Windows pipe ACL (current user's SID only) is still to do — checked on real Windows in stage 8, no native module
// meanwhile. Until then the pipe has Node's default DACL; a random name and the session token keep others out.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const MCP_DIR_NAME = "mcp";
export const MCP_SOCKET_FILE = "mcp.sock";
export const MCP_ENDPOINT_FILE = "endpoint.txt";
export const MCP_SESSION_DPAPI_FILE = "session.dpapi";
export const MCP_KEYCHAIN_SERVICE = "defE2End MCP session";

export type Exec = (file: string, args: string[], input?: string) => Promise<string>;

export const defaultExec: Exec = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    if (input !== undefined) child.stdin?.end(input);
  });

export function mcpDir(userData: string): string {
  return path.join(userData, MCP_DIR_NAME);
}

export interface McpEndpoint {
  dir: string;
  /** What `net.Server.listen` takes. */
  address: string;
  /** Run after `listen`: file modes on unix. */
  secure(): Promise<void>;
  publishToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
}

/** Creates DIR (0700) and removes a stale socket; picks a fresh pipe name on Windows. */
export async function prepareMcpEndpoint(userData: string, platform: NodeJS.Platform = process.platform, exec: Exec = defaultExec): Promise<McpEndpoint> {
  const dir = mcpDir(userData);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (platform === "win32") {
    const address = `\\\\.\\pipe\\defe2end-mcp-${randomBytes(16).toString("hex")}`;
    await writeFile(path.join(dir, MCP_ENDPOINT_FILE), address, "utf8");
    return {
      dir,
      address,
      secure: async () => {},
      publishToken: async (token) => writeFile(path.join(dir, MCP_SESSION_DPAPI_FILE), await dpapiProtect(token, exec), "utf8"),
      clearToken: () => rm(path.join(dir, MCP_SESSION_DPAPI_FILE), { force: true }),
    };
  }
  await chmod(dir, 0o700);
  const address = path.join(dir, MCP_SOCKET_FILE);
  await rm(address, { force: true });
  return {
    dir,
    address,
    secure: () => chmod(address, 0o600),
    publishToken: async (token) => {
      await exec("security", ["add-generic-password", "-U", "-s", MCP_KEYCHAIN_SERVICE, "-a", dir, "-w", token]).catch((err) => {
        throw tokenFreeError("security", err);
      });
    },
    clearToken: async () => {
      await exec("security", ["delete-generic-password", "-s", MCP_KEYCHAIN_SERVICE, "-a", dir]).catch(() => {});
    },
  };
}

/** DPAPI CurrentUser through PowerShell; the token goes in on stdin, never on the command line. */
export async function dpapiProtect(token: string, exec: Exec = defaultExec): Promise<string> {
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$t=[Console]::In.ReadToEnd().Trim();" +
    "$b=[System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($t),$null,'CurrentUser');" +
    "[Console]::Out.Write([Convert]::ToBase64String($b))";
  const out = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], token).catch((err) => {
    throw tokenFreeError("dpapi", err);
  });
  return out.trim();
}

/**
 * The exec error of a token write carries the command line (`security … -w <token>`); only its code goes on.
 */
export class TokenWriteError extends Error {
  constructor(readonly code: string) {
    super(`Session token write failed (${code})`);
    this.name = "TokenWriteError";
  }
}

function tokenFreeError(tool: string, err: unknown): TokenWriteError {
  const e = err as { code?: unknown; signal?: unknown } | null;
  const code = typeof e?.code === "number" || typeof e?.code === "string" ? String(e.code) : typeof e?.signal === "string" ? e.signal : "failed";
  return new TokenWriteError(`${tool}:${code}`);
}

/**
 * Writes session tokens one at a time, newest wins: a write queued for a token that was replaced meanwhile is
 * skipped, so an old generation's slow write can't land after the new one. Failures are reported by code only.
 */
export class TokenPublisher {
  private latest: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly endpoint: Pick<McpEndpoint, "publishToken">,
    private readonly onError: (code: string) => void,
  ) {}

  publish(token: string): void {
    if (this.closed) return;
    this.latest = token;
    this.chain = this.chain.then(async () => {
      if (this.closed || this.latest !== token) return;
      await this.endpoint.publishToken(token).catch((err) => this.onError(err instanceof TokenWriteError ? err.code : "failed"));
    });
  }

  idle(): Promise<void> {
    return this.chain;
  }

  /** No more writes; waits for the one in flight. */
  async close(): Promise<void> {
    this.closed = true;
    await this.chain;
  }
}
