// Stage 6 contract section 6: how Claude Code and Codex start `defe2end-mcp` — the app's own executable in Node mode
// running the bundled script. One function builds the command; registration removes an existing `defe2end` first.
import path from "node:path";

export const MCP_SERVER_NAME = "defe2end";

export interface McpCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}


export function mcpCommand(opts: { execPath: string; scriptPath: string; mcpDir: string }): McpCommand {
  return { command: opts.execPath, args: [opts.scriptPath], env: { ELECTRON_RUN_AS_NODE: "1", DEFE2END_MCP_DIR: opts.mcpDir } };
}

/** Packaged: `resources/mcp/defe2end-mcp.mjs`; in development the bundle in `dist/mcp` (scripts/bundle-mcp.mjs). */
export function mcpScriptPath(opts: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return opts.packaged ? path.join(opts.resourcesPath, "mcp", "defe2end-mcp.mjs") : path.join(opts.appPath, "dist", "mcp", "defe2end-mcp.mjs");
}

export type McpCli = "claude" | "codex";

/** argv for removing and adding the registration. */
export function registerArgs(cli: McpCli, cmd: McpCommand): { remove: string[]; add: string[] } {
  const env = Object.entries(cmd.env).flatMap(([k, v]) => [cli === "claude" ? "-e" : "--env", `${k}=${v}`]);
  if (cli === "claude") {
    return { remove: ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME], add: ["mcp", "add", "--scope", "user", MCP_SERVER_NAME, ...env, "--", cmd.command, ...cmd.args] };
  }
  return { remove: ["mcp", "remove", MCP_SERVER_NAME], add: ["mcp", "add", MCP_SERVER_NAME, ...env, "--", cmd.command, ...cmd.args] };
}

export type McpRegistration = "registered" | "outdated" | "missing";

/** From `<cli> mcp get defe2end` output (null = not registered): does it point at this app's script? */
export function registrationState(output: string | null, cmd: McpCommand): McpRegistration {
  if (output === null || !output.includes(MCP_SERVER_NAME)) return "missing";
  return output.includes(cmd.command) && cmd.args.every((a) => output.includes(a)) ? "registered" : "outdated";
}

export type RunCli = (cli: McpCli, args: string[]) => Promise<{ code: number; stdout: string }>;

export interface CliRegistration {
  cli: McpCli;
  /** `not-installed` when the CLI couldn't be run. */
  state: McpRegistration | "not-installed";
}

export async function registrationOf(cli: McpCli, cmd: McpCommand, run: RunCli): Promise<CliRegistration> {
  try {
    const res = await run(cli, ["mcp", "get", MCP_SERVER_NAME]);
    return { cli, state: registrationState(res.code === 0 ? res.stdout : null, cmd) };
  } catch {
    return { cli, state: "not-installed" };
  }
}

/** Removes any `defe2end` registration and adds this app's. */
export async function register(cli: McpCli, cmd: McpCommand, run: RunCli): Promise<CliRegistration> {
  const { remove, add } = registerArgs(cli, cmd);
  try {
    await run(cli, remove); // fails harmlessly when there is none
    const res = await run(cli, add);
    if (res.code !== 0) return { cli, state: "missing" };
  } catch {
    return { cli, state: "not-installed" };
  }
  return registrationOf(cli, cmd, run);
}
