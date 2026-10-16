import { chmodSync, copyFileSync, existsSync, linkSync, symlinkSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChatManager, claudeUserMessage, validateImages, MAX_IMAGE_BYTES, type ChatEvent } from "./chat.js";
import { detectProvider, findCandidates, resolveWindowsEntry, type CliEntry } from "./detect.js";
import { buildLaunch, claudeMcpConfig, codexConfigToml, prepareTurn } from "./launch.js";
import { checkClaudeInit, checkClaudePreflight, claudeEventProblem, codexViolation } from "./guard.js";
import { isAuthFailure, runTurn, type TurnEvent } from "./process.js";
import { isSupportedVersion, parseVersion } from "./versions.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "defe2end-ai-"));
const entry = { command: "/usr/local/bin/claude", prefixArgs: [] };
const MCP = { command: "/app/defe2end-mcp", args: ["--socket", "/tmp/s"], env: { DEFE2END_SOCKET_TOKEN: "t" } };

describe("versions", () => {
  it("parses both CLIs and refuses below the checked range", () => {
    expect(parseVersion("2.1.300 (Claude Code)")).toBe("2.1.300");
    expect(parseVersion("codex-cli 0.162.1")).toBe("0.162.1");
    expect(isSupportedVersion("claude", "2.1.300")).toBe(true);
    expect(isSupportedVersion("claude", "2.2.0")).toBe(true);
    expect(isSupportedVersion("claude", "2.1.299")).toBe(false);
    expect(isSupportedVersion("codex", "0.162.1")).toBe(true);
    expect(isSupportedVersion("codex", "0.162.0")).toBe(false);
  });
});

describe("launch arguments", () => {
  it("claude: restricted, no tools, strict MCP config, no session files, stream-json both ways", () => {
    const l = buildLaunch({ provider: "claude", entry, workDir: "/data/ai/work", systemPrompt: "SP", mcpConfigPath: "/data/ai/mcp.json" });
    expect(l.command).toBe("/usr/local/bin/claude");
    expect(l.args.slice(0, 15)).toEqual([
      "-p", "--restricted", "--tools", "", "--strict-mcp-config", "--mcp-config", "/data/ai/mcp.json",
      "--no-session-persistence", "--disable-slash-commands", "--output-format", "stream-json", "--input-format", "stream-json",
      "--verbose", "--include-partial-messages",
    ]);
    for (const banned of ["--bare", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode", "--allowedTools", "--add-dir", "--settings"]) {
      expect(l.args).not.toContain(banned);
    }
    expect(l.cwd).toBe("/data/ai/work");
    expect(l.env).toEqual({});
  });

  it("claude chat approves the defe2end MCP tools only; diagnosis approves nothing", () => {
    const chat = buildLaunch({ provider: "claude", entry, workDir: "/w", systemPrompt: "", mcpConfigPath: "/m", allowMcp: true });
    const i = chat.args.indexOf("--allowedTools");
    expect(chat.args.slice(i, i + 2)).toEqual(["--allowedTools", "mcp__defe2end"]);
    expect(chat.args.filter((a) => a === "--allowedTools")).toHaveLength(1);
    expect(chat.args.slice(0, 4)).toEqual(["-p", "--restricted", "--tools", ""]);
    const diagnosis = buildLaunch({ provider: "claude", entry, workDir: "/w", systemPrompt: "", mcpConfigPath: "/m", allowMcp: false });
    expect(diagnosis.args).not.toContain("--allowedTools");
  });

  it("codex: isolated CODEX_HOME, ephemeral, read-only sandbox, prompt on stdin", () => {
    const l = buildLaunch({ provider: "codex", entry: { command: "codex", prefixArgs: [] }, workDir: "/w", systemPrompt: "SP", codexHome: "/h", imagePaths: ["/i/1.png"] });
    expect(l.env).toEqual({ CODEX_HOME: "/h" });
    expect(l.args).toEqual(["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", "/w", "--image", "/i/1.png", "-"]);
    expect(l.args.join(" ")).not.toMatch(/danger|full-auto|workspace-write|bypass/);
  });

  it("keeps the Windows shim prefix in front", () => {
    const l = buildLaunch({ provider: "claude", entry: { command: "node", prefixArgs: ["C:\\npm\\cli.js"] }, workDir: "/w", systemPrompt: "", mcpConfigPath: "/m" });
    expect(l.args.slice(0, 2)).toEqual(["C:\\npm\\cli.js", "-p"]);
  });

  it("MCP configs hold defe2end alone (with the client name) or nothing", () => {
    expect(JSON.parse(claudeMcpConfig(MCP))).toEqual({
      mcpServers: { defe2end: { command: MCP.command, args: MCP.args, env: { DEFE2END_SOCKET_TOKEN: "t", DEFE2END_MCP_CLIENT: "claude" } } },
    });
    expect(JSON.parse(claudeMcpConfig(null))).toEqual({ mcpServers: {} });
    const toml = codexConfigToml(MCP);
    expect(toml.startsWith('web_search = "disabled"\n')).toBe(true);
    expect(toml).not.toContain("code_mode_host"); // 0.162.1 calls MCP tools only through code mode
    for (const f of ["shell_tool", "unified_exec", "view_image", "image_generation", "multi_agent", "apps", "plugins", "computer_use", "browser_use"]) {
      expect(toml).toMatch(new RegExp(`^${f} = false$`, "m"));
    }
    expect(toml).not.toMatch(/= true/);
    expect(toml).toContain('[mcp_servers.defe2end]\ncommand = "/app/defe2end-mcp"\nargs = ["--socket", "/tmp/s"]');
    expect(toml).toContain('DEFE2END_MCP_CLIENT = "codex"');
    expect(toml.match(/\[mcp_servers\./g)).toHaveLength(2); // the server and its env table
    expect(codexConfigToml(null)).not.toContain("mcp_servers");
  });

  it("turn files: auth link + config only in CODEX_HOME, everything gone after cleanup", async () => {
    const base = tmp();
    const userHome = tmp();
    writeFileSync(path.join(userHome, "auth.json"), "{}");
    writeFileSync(path.join(userHome, "config.toml"), "[mcp_servers.other]\ncommand='x'");
    const files = await prepareTurn(base, "codex", MCP, [{ mediaType: "image/png", data: Buffer.from("png") }], userHome);
    expect(readdirSync(files.codexHome!).sort()).toEqual(["auth.json", "config.toml"]);
    expect(readFileSync(files.codexHome! + "/config.toml", "utf8")).not.toContain("other");
    expect(readdirSync(files.workDir)).toEqual([]);
    expect(files.imagePaths).toHaveLength(1);
    await files.cleanup();
    expect(readdirSync(base)).toEqual([]);
    expect(existsSync(path.join(userHome, "auth.json"))).toBe(true);
  });
});

describe("detection", () => {
  it("finds candidates on PATH and refuses an unsupported version", async () => {
    const dir = tmp();
    const write = (version: string) => writeFakeExe(dir, "claude", `console.log(${JSON.stringify(version)});`);
    const { file } = write("2.1.200 (Claude Code)");
    expect(findCandidates("claude", [dir, path.join(dir, "nonexistent")].join(path.delimiter), process.platform)).toEqual([file]);
    const pathValue = [dir, nodeOnlyDir()].join(path.delimiter);
    const s = await detectProvider("claude", { platform: process.platform, pathValue });
    expect(s).toMatchObject({ state: "unsupported", version: "2.1.200", minVersion: "2.1.300" });
    write("2.1.301 (Claude Code)");
    expect(await detectProvider("claude", { platform: process.platform, pathValue })).toMatchObject({ state: "ready", version: "2.1.301" });
    expect(await detectProvider("codex", { platform: process.platform, pathValue })).toEqual({ provider: "codex", state: "missing", candidates: 0 });
  });

  it("a candidate that doesn't answer in time is skipped", async () => {
    const dir = tmp();
    writeFakeExe(dir, "codex", "setTimeout(() => {}, 5000);");
    expect(await detectProvider("codex", { platform: process.platform, pathValue: [dir, nodeOnlyDir()].join(path.delimiter), versionTimeoutMs: 200 })).toMatchObject({ state: "missing", candidates: 1 });
  });

  it("resolves the real entry behind a Windows npm shim", () => {
    const js = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
    expect(resolveWindowsEntry("C:\\npm\\claude.cmd", () => js)).toEqual({ command: "node", prefixArgs: ["C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"] });
    const exe = '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n';
    expect(resolveWindowsEntry("C:\\npm\\claude.cmd", () => exe)).toEqual({ command: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe", prefixArgs: [] });
    expect(resolveWindowsEntry("C:\\bin\\codex.exe")).toEqual({ command: "C:\\bin\\codex.exe", prefixArgs: [] });
    // A batch file with no target can't be spawned without a shell: skipped, not run through cmd.exe.
    expect(resolveWindowsEntry("C:\\bin\\claude.cmd", () => "@echo 2.1.300\r\n")).toBeNull();
  });
});

// A fake CLI: FAKE_MODE picks the behavior; it records its argv and a grandchild pid next to itself.
/**
 * A fake executable named `name` in `dir`, found and started the way the app does it: an executable node script on
 * macOS/Linux, an npm-style `.cmd` shim next to a `.js` file on Windows (resolved by `resolveWindowsEntry`).
 */
function writeFakeExe(dir: string, name: string, body: string): { file: string; entry: CliEntry } {
  if (process.platform === "win32") {
    writeFileSync(path.join(dir, `${name}.js`), body);
    const file = path.join(dir, `${name}.cmd`);
    writeFileSync(file, `@ECHO off\r\nnode "%~dp0\\${name}.js" %*\r\n`);
    return { file, entry: resolveWindowsEntry(file)! };
  }
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}`);
  chmodSync(file, 0o755);
  return { file, entry: { command: file, prefixArgs: [] } };
}

/**
 * A folder holding only `node`, so a PATH of "fake CLIs + this" starts the fakes (they run on node) without picking
 * up a real claude/codex installed next to the test's node.
 */
function nodeOnlyDir(): string {
  const dir = tmp();
  const target = path.join(dir, path.basename(process.execPath));
  if (process.platform === "win32") {
    try {
      linkSync(process.execPath, target);
    } catch {
      copyFileSync(process.execPath, target);
    }
  } else {
    symlinkSync(process.execPath, path.join(dir, "node"));
  }
  return dir;
}

function fakeCli(): { file: string; dir: string; entry: CliEntry } {
  const dir = tmp();
  return { dir, ...writeFakeExe(dir, "fake-cli", FAKE_CLI) };
}

// FAKE_MODE picks the behavior; it records its argv and a grandchild pid next to itself. Grandchildren are node
// processes so the tree looks the same on every platform.
const FAKE_CLI = `
const fs = require("fs"); const path = require("path"); const { spawn } = require("child_process");
fs.writeFileSync(path.join(__dirname, "argv.json"), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), codexHome: process.env.CODEX_HOME || null, mcp: process.argv.includes("--mcp-config") && fs.existsSync(process.argv[process.argv.indexOf("--mcp-config") + 1]) ? fs.readFileSync(process.argv[process.argv.indexOf("--mcp-config") + 1], "utf8") : null }));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const PRE = process.env.FAKE_PREFLIGHT || "ok";
if (PRE === "exit0") process.exit(0);
let input = ""; let pending = "";
process.stdin.on("data", (c) => {
  input += c; pending += c; let i;
  while ((i = pending.indexOf("\\n")) >= 0) {
    const l = pending.slice(0, i); pending = pending.slice(i + 1);
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.type !== "control_request") continue;
    fs.appendFileSync(path.join(__dirname, "control.txt"), m.request.subtype + "\\n");
    if (PRE === "silent") continue;
    const sub = m.request.subtype;
    const body = sub === "mcp_status" ? { mcpServers: PRE === "bad-mcp" ? [{ name: "other" }] : [] }
      : sub === "get_context_usage" ? { categories: [{ name: "System prompt" }, ...(PRE === "bad-tools" ? [{ name: "System tools" }] : [])], mcpTools: [] } : {};
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: body } });
  }
});
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(__dirname, "stdin.txt"), input.split("\\n").filter((l) => l && !l.includes('"control_request"')).join("\\n"));
  const mode = process.env.FAKE_MODE;
  if (mode === "claude-ok") {
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } });
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } });
    out({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "Hello" });
  } else if (mode === "codex-ok") {
    out({ type: "thread.started" });
    out({ type: "item.completed", item: { type: "agent_message", text: "Done" } });
  } else if (mode === "claude-auth") {
    out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    process.exit(1);
  } else if (mode === "codex-auth") {
    process.stderr.write("ERROR: 401 Unauthorized: token_expired\\n"); process.exit(1);
  } else if (mode === "codex-noitem") {
    out({ type: "item.completed" });
    setInterval(() => {}, 1000);
  } else if (mode === "codex-unknown") {
    out({ type: "thread.forked" });
    setInterval(() => {}, 1000);
  } else if (mode === "claude-garbage") {
    process.stdout.write("not json\\n");
    setInterval(() => {}, 1000);
  } else if (mode === "codex-exec") {
    out({ type: "item.started", item: { id: "i1", type: "command_execution", command: "ls ~" } });
    setInterval(() => {}, 1000);
  } else if (mode === "codex-mcp") {
    out({ type: "item.completed", item: { id: "i0", type: "error", message: "Code Mode is unavailable because code-mode host is disabled." } });
    out({ type: "item.completed", item: { id: "i1", type: "mcp_tool_call", server: "defe2end", tool: "list_runs" } });
    out({ type: "item.completed", item: { type: "agent_message", text: "Done" } });
  } else if (mode === "stubborn") {
    process.on("SIGTERM", () => {});
    const g = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(path.join(__dirname, "pids.json"), JSON.stringify([process.pid, g.pid]));
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "..." } } });
    setInterval(() => {}, 1000);
  } else if (mode === "hang") {
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(path.join(__dirname, "pids.json"), JSON.stringify([process.pid, g.pid]));
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "..." } } });
    setInterval(() => {}, 1000);
  }
});
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("turns with a fake CLI", () => {
  const launchFor = (entry: CliEntry, provider: "claude" | "codex") =>
    buildLaunch({ provider, entry, workDir: os.tmpdir(), systemPrompt: "SP", mcpConfigPath: "/m", codexHome: "/h" });

  it("claude success streams deltas and finishes once", async () => {
    const { entry } = fakeCli();
    const events: TurnEvent[] = [];
    const r = await runTurn({ provider: "claude", launch: launchFor(entry, "claude"), input: "{}", onEvent: (e) => events.push(e), env: { ...process.env, FAKE_MODE: "claude-ok" } });
    expect(r).toMatchObject({ ok: true, text: "Hello" });
    expect(events).toEqual([{ type: "delta", text: "Hel" }, { type: "delta", text: "lo" }, { type: "done", text: "Hello" }]);
  });

  it("codex success", async () => {
    const { entry } = fakeCli();
    const r = await runTurn({ provider: "codex", launch: launchFor(entry, "codex"), input: "hi", onEvent: () => {}, env: { ...process.env, FAKE_MODE: "codex-ok" } });
    expect(r).toMatchObject({ ok: true, text: "Done" });
  });

  it("missing CLI and expired login are told apart", async () => {
    const gone = await runTurn({ provider: "claude", launch: launchFor({ command: path.join(tmp(), "no-such-claude"), prefixArgs: [] }, "claude"), input: "{}", onEvent: () => {} });
    expect(gone.error?.code).toBe("missing");
    const { entry } = fakeCli();
    const a = await runTurn({ provider: "claude", launch: launchFor(entry, "claude"), input: "{}", onEvent: () => {}, env: { ...process.env, FAKE_MODE: "claude-auth" } });
    expect(a.error?.code).toBe("auth");
    const b = await runTurn({ provider: "codex", launch: launchFor(entry, "codex"), input: "x", onEvent: () => {}, env: { ...process.env, FAKE_MODE: "codex-auth" } });
    expect(b.error?.code).toBe("auth");
    expect(isAuthFailure("selector not found")).toBe(false);
  });

  it("Claude: no answer to the pre-input check refuses without sending the message", async () => {
    const { entry, dir } = fakeCli();
    const r = await runTurn({ provider: "claude", launch: launchFor(entry, "claude"), input: '{"type":"user","x":"secret"}', onEvent: () => {}, env: { ...process.env, FAKE_MODE: "claude-ok", FAKE_PREFLIGHT: "silent" }, preflightTimeoutMs: 300 });
    expect(r.error?.code).toBe("unsafe");
    expect(r.treeGone).toBe(true);
    expect(existsSync(path.join(dir, "stdin.txt")) ? readFileSync(path.join(dir, "stdin.txt"), "utf8") : "").not.toContain("secret");
  });

  it("Claude: the pre-input check runs in order, then the message goes in", async () => {
    const { entry, dir } = fakeCli();
    const r = await runTurn({ provider: "claude", launch: launchFor(entry, "claude"), input: '{"type":"user"}', onEvent: () => {}, env: { ...process.env, FAKE_MODE: "claude-ok" } });
    expect(r.ok).toBe(true);
    expect(readFileSync(path.join(dir, "control.txt"), "utf8").trim().split("\n")).toEqual(["initialize", "mcp_status", "get_context_usage"]);
  });

  it("Codex: a command execution item ends the process tree", async () => {
    const { entry } = fakeCli();
    const r = await runTurn({ provider: "codex", launch: launchFor(entry, "codex"), input: "x", onEvent: () => {}, env: { ...process.env, FAKE_MODE: "codex-exec" } });
    expect(r.error).toMatchObject({ code: "unsafe", message: "tool item command_execution" });
    expect(r.treeGone).toBe(true);
  }, 10_000);

  it("Codex: defe2end MCP calls pass in chat, not in diagnosis; the code-mode error item is ignored", async () => {
    const { entry } = fakeCli();
    const env = { ...process.env, FAKE_MODE: "codex-mcp" };
    expect(await runTurn({ provider: "codex", launch: launchFor(entry, "codex"), input: "x", onEvent: () => {}, env })).toMatchObject({ ok: true, text: "Done" });
    const d = await runTurn({ provider: "codex", launch: launchFor(entry, "codex"), input: "x", onEvent: () => {}, env, allowMcp: false });
    expect(d.error).toMatchObject({ code: "unsafe", message: "MCP call defe2end/list_runs" });
  });

  it("Claude: a clean exit before the pre-input check is not a success", async () => {
    const { entry } = fakeCli();
    const r = await runTurn({ provider: "claude", launch: launchFor(entry, "claude"), input: "{}", onEvent: () => {}, env: { ...process.env, FAKE_MODE: "claude-ok", FAKE_PREFLIGHT: "exit0" } });
    expect(r).toMatchObject({ ok: false, error: { code: "unsafe", message: "exited before the pre-input check passed" } });
  });

  it("unreadable or unknown output ends the turn", async () => {
    const { entry } = fakeCli();
    const cases = [
      ["claude", "claude-garbage", "unreadable output line"],
      ["codex", "codex-noitem", "item without a type"],
      ["codex", "codex-unknown", "unknown event thread.forked"],
    ] as const;
    for (const [provider, mode, message] of cases) {
      const r = await runTurn({ provider, launch: launchFor(entry, provider), input: "{}", onEvent: () => {}, env: { ...process.env, FAKE_MODE: mode } });
      expect(r.error, mode).toMatchObject({ code: "unsafe", message });
      expect(r.treeGone, mode).toBe(true);
    }
  }, 15_000);

  it("guard checks", () => {
    expect(claudeEventProblem({ type: "rate_limit_event" })).toBeNull();
    expect(claudeEventProblem({ type: "system", subtype: "status" })).toBeNull();
    expect(claudeEventProblem({ type: "system", subtype: "permission_denied" })).toBeNull();
    expect(claudeEventProblem({ type: "system", subtype: "thinking_tokens" })).toBeNull();
    expect(claudeEventProblem({ type: "system", subtype: "hook_started" })).toBe("unknown system event hook_started");
    expect(claudeEventProblem({ type: "stream_event", event: { type: "ping2" } })).toBe("unknown stream event ping2");
    expect(claudeEventProblem({ type: "tool_progress" })).toBe("unknown event tool_progress");
    expect(codexViolation({ type: "turn.completed", usage: {} }, false)).toBeNull();
    expect(checkClaudeInit({ tools: ["mcp__defe2end__list_runs"], mcp_servers: [{ name: "defe2end", status: "connected" }] }, true)).toBeNull();
    expect(checkClaudeInit({ tools: ["Read"], mcp_servers: [] }, true)).toBe("unexpected tool Read");
    expect(checkClaudeInit({ tools: ["mcp__defe2end__x"], mcp_servers: [] }, false)).toBe("unexpected tool mcp__defe2end__x");
    expect(checkClaudeInit({}, true)).toBe("init has an unknown shape");
    expect(checkClaudePreflight({ mcpServers: [{ name: "defe2end" }] }, { categories: [{ name: "MCP tools" }], mcpTools: [{ name: "mcp__defe2end__a" }] }, true)).toBeNull();
    expect(checkClaudePreflight({ mcpServers: [{ name: "defe2end" }] }, { categories: [], mcpTools: [] }, false)).toBe("unexpected MCP server defe2end");
    expect(checkClaudePreflight({ mcpServers: [] }, { categories: [{ name: "Skills" }], mcpTools: [] }, true)).toBe("unexpected context category Skills");
    expect(codexViolation({ type: "item.started", item: { type: "web_search" } }, true)).toBe("tool item web_search");
    expect(codexViolation({ type: "item.completed", item: { type: "file_change" } }, true)).toBe("tool item file_change");
    expect(codexViolation({ type: "turn.completed" }, true)).toBeNull();
  });

  it("stop ends the whole process tree (the CLI and what it started)", async () => {
    const { entry, dir } = fakeCli();
    const controller = new AbortController();
    const events: TurnEvent[] = [];
    const done = runTurn({
      provider: "claude",
      launch: launchFor(entry, "claude"),
      input: "{}",
      onEvent: (e) => {
        events.push(e);
        if (e.type === "delta") controller.abort();
      },
      signal: controller.signal,
      env: { ...process.env, FAKE_MODE: "hang" },
    });
    const r = await done;
    expect(r.error?.code).toBe("stopped");
    expect(r.treeGone).toBe(true);
    const pids = JSON.parse(readFileSync(path.join(dir, "pids.json"), "utf8")) as number[];
    for (const pid of pids) expect(alive(pid)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "stopped" });
  }, 10_000);
});

describe("chat manager", () => {
  const setup = (mode: string) => {
    const { entry, dir } = fakeCli();
    const base = tmp();
    const events: ChatEvent[] = [];
    const chat = new ChatManager({
      baseDir: base,
      status: async () => [
        { provider: "claude", state: "ready", version: "2.1.300", entry },
        { provider: "codex", state: "unsupported", version: "0.100.0", minVersion: "0.162.1", path: "/x/codex" },
      ],
      mcpServer: () => MCP,
      emit: (e) => events.push(e),
      env: () => ({ ...process.env, FAKE_MODE: mode }),
    });
    const settled = () =>
      new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (events.some((e) => e.type === "done" || e.type === "error")) {
            clearInterval(t);
            setTimeout(resolve, 50);
          }
        }, 20);
      });
    return { chat, events, base, dir, settled };
  };

  it("runs a turn with the app's MCP config, then removes the turn folder", async () => {
    const { chat, events, base, dir, settled } = setup("claude-ok");
    expect(await chat.send({ threadId: "t1", provider: "claude", text: "hi" })).toEqual({ ok: true });
    await settled();
    expect(events.at(-1)).toMatchObject({ threadId: "t1", type: "done", text: "Hello" });
    const seen = JSON.parse(readFileSync(path.join(dir, "argv.json"), "utf8"));
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(Object.keys(JSON.parse(seen.mcp).mcpServers)).toEqual(["defe2end"]);
    expect(seen.cwd).toContain(base.split(path.sep).pop());
    expect(readdirSync(base)).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(dir, "stdin.txt"), "utf8")).message.content.at(-1)).toEqual({ type: "text", text: "hi" });
  });

  it("refuses an unsupported provider, a provider switch and oversized images", async () => {
    const { chat, settled } = setup("claude-ok");
    expect(await chat.send({ threadId: "t", provider: "codex", text: "hi" })).toEqual({ ok: false, reason: "provider_unavailable" });
    await chat.send({ threadId: "t", provider: "claude", text: "hi" });
    await settled();
    expect(await chat.send({ threadId: "t", provider: "codex", text: "again" })).toEqual({ ok: false, reason: "provider_locked" });
    const img = { mediaType: "image/png", base64: Buffer.alloc(10).toString("base64") };
    expect(validateImages([img, img, img, img, img])).toEqual({ ok: false, reason: "too_many_images" });
    expect(validateImages([{ mediaType: "image/png", base64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64") }])).toEqual({ ok: false, reason: "image_too_large" });
    expect(validateImages([{ mediaType: "text/html", base64: "" }])).toEqual({ ok: false, reason: "bad_image" });
    expect(validateImages([img, img, img, img]).ok).toBe(true);
  });

  it("diagnosis runs with an empty MCP config", async () => {
    const { chat, dir, settled } = setup("claude-ok");
    expect(await chat.diagnose("d1", "claude", "step failed")).toEqual({ ok: true });
    await settled();
    // The config file is gone with the turn folder; the argv shows which one was used and the system prompt.
    const seen = JSON.parse(readFileSync(path.join(dir, "argv.json"), "utf8"));
    expect(seen.argv[seen.argv.indexOf("--append-system-prompt") + 1]).toContain("no tools");
    expect(JSON.parse(seen.mcp)).toEqual({ mcpServers: {} });
  });

  it("stopAll waits for a CLI that ignores SIGTERM to be killed and its turn folder removed", async () => {
    const { chat, events, base, dir } = setup("stubborn");
    expect(await chat.send({ threadId: "q", provider: "claude", text: "hi" })).toEqual({ ok: true });
    for (let i = 0; i < 100 && !events.some((e) => e.type === "delta"); i++) await new Promise((r) => setTimeout(r, 20));
    await chat.stopAll();
    const pids = JSON.parse(readFileSync(path.join(dir, "pids.json"), "utf8")) as number[];
    for (const pid of pids) expect(alive(pid)).toBe(false);
    expect(readdirSync(base)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ threadId: "q", type: "error", code: "stopped" });
  }, 10_000);

  it("Claude: tools beyond the limits are refused before the message goes in, then that CLI stays refused", async () => {
    for (const pre of ["bad-tools", "bad-mcp"]) {
      const { chat, events, dir } = setup("claude-ok");
      process.env.FAKE_PREFLIGHT = pre;
      try {
        expect(await chat.send({ threadId: "u", provider: "claude", text: "secret question" })).toEqual({ ok: true });
        for (let i = 0; i < 200 && !events.some((e) => e.type === "error" || e.type === "done"); i++) await new Promise((r) => setTimeout(r, 20));
      } finally {
        delete process.env.FAKE_PREFLIGHT;
      }
      expect(events.at(-1)).toMatchObject({ type: "error", code: "unsafe" });
      expect(existsSync(path.join(dir, "stdin.txt")) ? readFileSync(path.join(dir, "stdin.txt"), "utf8") : "").not.toContain("secret question");
      await new Promise((r) => setTimeout(r, 50));
      expect(await chat.send({ threadId: "u2", provider: "claude", text: "again" })).toEqual({ ok: false, reason: "unsafe_cli" });
    }
  }, 15_000);

  it("Codex: a CLI that ran a command is refused for the rest of the app's life", async () => {
    const { entry } = fakeCli();
    const events: ChatEvent[] = [];
    const chat = new ChatManager({
      baseDir: tmp(),
      status: async () => [{ provider: "codex", state: "ready", version: "0.170.0", entry }],
      mcpServer: () => MCP,
      emit: (e) => events.push(e),
      env: () => ({ ...process.env, FAKE_MODE: "codex-exec" }),
    });
    expect(await chat.diagnose("d", "codex", "why")).toEqual({ ok: true });
    for (let i = 0; i < 200 && !events.some((e) => e.type === "error"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "unsafe" });
    await new Promise((r) => setTimeout(r, 50));
    expect(await chat.send({ threadId: "c", provider: "codex", text: "hi" })).toEqual({ ok: false, reason: "unsafe_cli" });
    expect(await chat.diagnose("d2", "codex", "why")).toEqual({ ok: false, reason: "unsafe_cli" });
  }, 10_000);

  it("two sends on one thread at once: the second is refused, stopAll ends the first", async () => {
    const { entry, dir } = fakeCli();
    const base = tmp();
    const chat = new ChatManager({
      baseDir: base,
      status: async () => [{ provider: "claude", state: "ready", version: "2.1.300", entry }],
      mcpServer: () => MCP,
      emit: () => {},
      env: () => ({ ...process.env, FAKE_MODE: "hang" }),
    });
    const [a, b] = await Promise.all([chat.send({ threadId: "x", provider: "claude", text: "1" }), chat.send({ threadId: "x", provider: "claude", text: "2" })]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: false, reason: "busy" });
    for (let i = 0; i < 200 && !existsSync(path.join(dir, "pids.json")); i++) await new Promise((r) => setTimeout(r, 20));
    await chat.stopAll();
    for (const pid of JSON.parse(readFileSync(path.join(dir, "pids.json"), "utf8")) as number[]) expect(alive(pid)).toBe(false);
    expect(chat.activeRuns).toBe(0);
    expect(readdirSync(base)).toEqual([]);
  }, 10_000);

  it("a request still detecting the CLI when the account changes never starts", async () => {
    const { entry, dir } = fakeCli();
    let identity = "server|A|dev|1";
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const chat = new ChatManager({
      baseDir: tmp(),
      status: async () => {
        await gate;
        return [{ provider: "claude", state: "ready", version: "2.1.300", entry }];
      },
      mcpServer: () => MCP,
      emit: () => {},
      identity: () => identity,
      env: () => ({ ...process.env, FAKE_MODE: "claude-ok" }),
    });
    const pendingSend = chat.send({ threadId: "y", provider: "claude", text: "as A" });
    const pendingDiag = chat.diagnose("z", "claude", "as A");
    expect(chat.activeRuns).toBe(2);
    identity = "server|B|dev|2";
    const stopping = chat.stopAll();
    release();
    expect(await pendingSend).toEqual({ ok: false, reason: "stopped" });
    expect(await pendingDiag).toEqual({ ok: false, reason: "stopped" });
    await stopping;
    expect(chat.activeRuns).toBe(0);
    expect(existsSync(path.join(dir, "argv.json"))).toBe(false);
  });

  it("an identity change without stopAll still keeps the old request from starting", async () => {
    const { entry, dir } = fakeCli();
    let identity = "A";
    const chat = new ChatManager({
      baseDir: tmp(),
      status: async () => [{ provider: "claude", state: "ready", version: "2.1.300", entry }],
      mcpServer: () => MCP,
      emit: () => {},
      identity: () => identity,
      env: async () => {
        identity = "B";
        return { ...process.env, FAKE_MODE: "claude-ok" };
      },
    });
    expect(await chat.send({ threadId: "w", provider: "claude", text: "hi" })).toEqual({ ok: true });
    for (let i = 0; i < 100 && chat.activeRuns > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(path.join(dir, "argv.json"))).toBe(false);
  });

  it("the user message carries images inline for Claude", () => {
    const line = JSON.parse(claudeUserMessage("look", [{ mediaType: "image/png", data: Buffer.from("x") }]));
    expect(line.message.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "eA==" } });
  });
});
