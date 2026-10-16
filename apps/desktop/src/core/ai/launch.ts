// Stage 6 contract section 7, launch. One pure function decides how a provider CLI is started; the argument tests
// pin the limits (no command/code tools, only the defE2End MCP server, no user settings, no session files). The
// limits are the boundary — the system prompt line about page text is only a helper.
import { mkdir, mkdtemp, rm, symlink, copyFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliEntry } from "./detect.js";
import { MCP_SERVER } from "./guard.js";
import type { Provider } from "./versions.js";

/** How to start `defe2end-mcp` — made by the socket side and passed in. */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface LaunchInput {
  provider: Provider;
  entry: CliEntry;
  /** Empty folder under the app data; the CLI's working directory. */
  workDir: string;
  systemPrompt: string;
  /** Claude: the MCP config file the app wrote (`mcpServers` has `defe2end` or nothing). */
  mcpConfigPath?: string;
  /** Claude: whether the defe2end MCP tools may run (chat) or the turn has no tools at all (diagnosis). */
  allowMcp?: boolean;
  /** Codex: the isolated CODEX_HOME (auth.json link + the app's config.toml only). */
  codexHome?: string;
  /** Codex: attached image files (Claude gets them inline over stream-json). */
  imagePaths?: string[];
}

export interface Launch {
  command: string;
  args: string[];
  /** Added to the app's environment. */
  env: Record<string, string>;
  cwd: string;
  /** What goes to stdin: one stream-json user message (Claude) or the prompt text (Codex). */
  stdin: "stream-json" | "text";
}

export function buildLaunch(input: LaunchInput): Launch {
  const { entry } = input;
  if (input.provider === "claude") {
    if (!input.mcpConfigPath) throw new Error("claude launch needs an MCP config");
    return {
      command: entry.command,
      args: [
        ...entry.prefixArgs,
        "-p",
        "--restricted",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        input.mcpConfigPath,
        "--no-session-persistence",
        "--disable-slash-commands",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        // `-p` with stream-json output refuses to start without --verbose; partial messages give the live text.
        "--verbose",
        "--include-partial-messages",
        // `-p` has no one to ask, so an unapproved MCP call comes back "permission denied" (2.1.300 on this Mac).
        // This approves the defe2end server's tools only; it is not the boundary (--tools "" and the strict MCP config are).
        ...(input.allowMcp ? ["--allowedTools", `mcp__${MCP_SERVER}`] : []),
        "--append-system-prompt",
        input.systemPrompt,
      ],
      env: {},
      cwd: input.workDir,
      stdin: "stream-json",
    };
  }
  if (!input.codexHome) throw new Error("codex launch needs an isolated CODEX_HOME");
  return {
    command: entry.command,
    args: [
      ...entry.prefixArgs,
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--cd",
      input.workDir,
      ...(input.imagePaths ?? []).flatMap((p) => ["--image", p]),
      "-",
    ],
    env: { CODEX_HOME: input.codexHome },
    cwd: input.workDir,
    stdin: "text",
  };
}

/** Claude `--mcp-config` body: `defe2end` alone, or nothing (diagnosis). */
export function claudeMcpConfig(mcp: McpServerSpec | null): string {
  const servers = mcp ? { defe2end: { command: mcp.command, args: mcp.args, env: { ...mcp.env, DEFE2END_MCP_CLIENT: "claude" } } } : {};
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

const tomlString = (s: string) => JSON.stringify(s);
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

/**
 * Built-in Codex tools turned off in the isolated CODEX_HOME. Checked on codex-cli 0.162.1 (`codex features list`
 * and asking the model for its tool list): with `shell_tool` alone, `view_image` (reads any image file), image
 * generation, goals, web search and plugin/app tools stay. Left on: `apply_patch` (no config key in this version; the
 * read-only sandbox refuses the write), collaboration tools, `request_user_input`, and code mode's `exec`.
 * `exec` stays because 0.162.1 reaches MCP tools only through it: with `code_mode_host = false` the defe2end tools
 * can't be called at all (2026-10-16 on this Mac). Its script has no `fs`/`require`/`process`/`Deno` and refuses
 * `import("node:fs")`, so it can only call the tools left here, and each defe2end call still shows as an
 * `mcp_tool_call` item that the guard checks.
 */
export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "image_generation",
  "multi_agent",
  "goals",
  "apps",
  "plugins",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "sleep_tool",
  "tool_suggest",
  "hooks",
  "skill_mcp_dependency_install",
] as const;

/** Codex `config.toml` in the isolated CODEX_HOME: no web search, the built-in tools above off, `defe2end` alone or no MCP server (diagnosis). */
export function codexConfigToml(mcp: McpServerSpec | null): string {
  const lines = ['web_search = "disabled"', "", "[features]", ...CODEX_DISABLED_FEATURES.map((f) => `${f} = false`), ""];
  if (mcp) {
    lines.push("[mcp_servers.defe2end]", `command = ${tomlString(mcp.command)}`, `args = [${mcp.args.map(tomlString).join(", ")}]`, "");
    lines.push("[mcp_servers.defe2end.env]");
    for (const [k, v] of Object.entries({ ...mcp.env, DEFE2END_MCP_CLIENT: "codex" })) lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
    lines.push("");
  }
  return lines.join("\n");
}

export interface TurnFiles {
  dir: string;
  workDir: string;
  mcpConfigPath?: string;
  codexHome?: string;
  imagePaths: string[];
  /** Removes everything above (MCP config, images, the isolated homes). */
  cleanup(): Promise<void>;
}

export interface Attachment {
  mediaType: string;
  data: Buffer;
}

const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/**
 * Writes one turn's files under `baseDir`: an empty work folder, the MCP config (Claude) or the isolated CODEX_HOME
 * (Codex, with a link to the user's auth.json), and Codex image attachments. All of it goes in `cleanup()`.
 */
export async function prepareTurn(
  baseDir: string,
  provider: Provider,
  mcp: McpServerSpec | null,
  images: Attachment[] = [],
  userCodexHome: string = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
): Promise<TurnFiles> {
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "turn-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const workDir = path.join(dir, "work");
    await mkdir(workDir);
    if (provider === "claude") {
      const mcpConfigPath = path.join(dir, "mcp.json");
      await writeFile(mcpConfigPath, claudeMcpConfig(mcp), { mode: 0o600 });
      return { dir, workDir, mcpConfigPath, imagePaths: [], cleanup };
    }
    const codexHome = path.join(dir, "codex-home");
    await mkdir(codexHome, { mode: 0o700 });
    await writeFile(path.join(codexHome, "config.toml"), codexConfigToml(mcp), { mode: 0o600 });
    const auth = path.join(userCodexHome, "auth.json");
    await symlink(auth, path.join(codexHome, "auth.json")).catch(() => copyFile(auth, path.join(codexHome, "auth.json")).catch(() => undefined));
    const imagePaths: string[] = [];
    for (const [i, image] of images.entries()) {
      const file = path.join(dir, `image-${i + 1}.${EXTENSION[image.mediaType] ?? "png"}`);
      await writeFile(file, image.data, { mode: 0o600 });
      imagePaths.push(file);
    }
    return { dir, workDir, codexHome, imagePaths, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
