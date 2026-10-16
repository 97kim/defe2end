// One CLI turn as a process: spawn from a `Launch`, read the JSON lines, and on stop end the whole process tree —
// `defe2end-mcp` runs under the CLI, and its exit closes the app socket, which cancels its pending calls.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { checkClaudeInit, checkClaudePreflight, claudeEventProblem, codexViolation } from "./guard.js";
import type { Launch } from "./launch.js";
import type { Provider } from "./versions.js";

export type TurnEvent = { type: "delta"; text: string } | { type: "done"; text: string } | { type: "error"; code: TurnErrorCode; message: string };
/** `unsafe`: the CLI showed tools beyond the launch limits (guard.ts); the turn was ended. */
export type TurnErrorCode = "auth" | "missing" | "failed" | "stopped" | "unsafe";

/** CLI output that means the CLI's own login is gone (not the MCP token). Checked on failures only. */
const AUTH_PATTERNS = [
  /not logged in/i,
  /please (?:run )?\/?login/i,
  /(?:claude|codex) login/i,
  /oauth token (?:has )?expired/i,
  /invalid api key/i,
  /authentication[_ ](?:error|failed)/i,
  /\b401\b.*unauthori[sz]ed/i,
  /refresh token/i,
  /token[_ ]expired/i,
];
export function isAuthFailure(text: string): boolean {
  return AUTH_PATTERNS.some((p) => p.test(text));
}

interface Parsed {
  delta?: string;
  final?: string;
  error?: string;
}

/** One stdout line of `claude --output-format stream-json --include-partial-messages`. */
export function parseClaudeLine(line: string, sawDelta: boolean): Parsed {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return {};
  }
  if (msg?.type === "stream_event" && msg.event?.type === "content_block_delta" && msg.event.delta?.type === "text_delta") return { delta: String(msg.event.delta.text ?? "") };
  if (msg?.type === "assistant" && !sawDelta) {
    const text = (msg.message?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
    return text ? { delta: text } : {};
  }
  if (msg?.type === "result") return msg.is_error || msg.subtype !== "success" ? { error: String(msg.result ?? msg.subtype ?? "error") } : { final: String(msg.result ?? "") };
  return {};
}

/** One stdout line of `codex exec --json`. */
export function parseCodexLine(line: string): Parsed {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return {};
  }
  if (msg?.type === "item.completed" && msg.item?.type === "agent_message") return { delta: String(msg.item.text ?? "") };
  if (msg?.type === "turn.failed") return { error: String(msg.error?.message ?? "turn failed") };
  if (msg?.type === "error") return { error: String(msg.message ?? "error") };
  return {};
}

/** Ends a spawned process and everything under it; resolves true once nothing of the tree is left. */
export async function killTree(child: ChildProcess, graceMs = 1500): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return true;
  if (process.platform === "win32") {
    // No process groups or SIGTERM on Windows: taskkill /T /F ends the leader's tree (as the runner does for the
    // browser). It must run while the leader is alive, since the tree is found through it.
    const leaderAlive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    for (let i = 0; i < 20 && leaderAlive(); i++) {
      await new Promise<void>((resolve) => execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
      if (leaderAlive()) await new Promise((r) => setTimeout(r, 50));
    }
    return !leaderAlive();
  }
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch {
      // already gone
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (alive()) signal("SIGKILL");
  for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
  return !alive();
}

export interface RunTurnOptions {
  provider: Provider;
  launch: Launch;
  /** Claude: the stream-json user message line; Codex: the prompt text. */
  input: string;
  onEvent: (event: TurnEvent) => void;
  signal?: AbortSignal;
  /** Base environment (the user's shell PATH); `launch.env` is laid over it. */
  env?: NodeJS.ProcessEnv;
  /** Whether defe2end MCP tools are allowed (chat) or nothing at all (diagnosis). Default true. */
  allowMcp?: boolean;
  /** How long Claude may take to answer the pre-input check. Default 15 s. */
  preflightTimeoutMs?: number;
}

export interface TurnResult {
  ok: boolean;
  text: string;
  error?: { code: TurnErrorCode; message: string };
  /** Set when the turn was stopped: whether the process tree was gone afterwards. */
  treeGone?: boolean;
}

/** Runs one turn; never throws. Emits deltas as they come and exactly one `done` or `error`. */
export function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const { provider, launch, onEvent, signal } = options;
  return new Promise((resolve) => {
    let child: ChildProcess;
    let text = "";
    let finalText: string | null = null;
    let failure: string | null = null;
    let stderr = "";
    let sawDelta = false;
    let settled = false;
    let stopping: Promise<boolean> | null = null;
    let unsafe: string | null = null;
    const allowMcp = options.allowMcp ?? true;
    const finish = (result: TurnResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (result.ok) onEvent({ type: "done", text: result.text });
      else onEvent({ type: "error", code: result.error!.code, message: result.error!.message });
      resolve(result);
    };
    const onAbort = () => {
      stopping ??= killTree(child);
    };
    const refuse = (reason: string) => {
      unsafe ??= reason;
      stopping ??= killTree(child);
    };
    try {
      child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: { ...(options.env ?? process.env), ...launch.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      return finish({ ok: false, text: "", error: { code: "missing", message: err instanceof Error ? err.message : String(err) } });
    }
    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) onAbort();
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (unsafe) continue;
        let msg: any = null;
        try {
          msg = JSON.parse(line);
        } catch {
          refuse("unreadable output line");
          continue;
        }
        if (provider === "claude" && msg?.type === "control_response") {
          onControl(msg.response);
          continue;
        }
        const violation =
          provider === "claude"
            ? (claudeEventProblem(msg) ?? (msg.type === "system" && msg.subtype === "init" ? checkClaudeInit(msg, allowMcp) : null))
            : codexViolation(msg, allowMcp);
        if (violation) {
          refuse(violation);
          continue;
        }
        const parsed = provider === "claude" ? parseClaudeLine(line, sawDelta) : parseCodexLine(line);
        if (parsed.delta) {
          if (provider === "codex" && text) {
            text += "\n\n";
            onEvent({ type: "delta", text: "\n\n" });
          }
          sawDelta = true;
          text += parsed.delta;
          onEvent({ type: "delta", text: parsed.delta });
        }
        if (parsed.final !== undefined) finalText = parsed.final;
        if (parsed.error) failure = parsed.error;
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      if (stderr.length < 16_000) stderr += chunk;
    });
    child.stdin!.on("error", () => undefined);
    // Claude: initialize → mcp_status → get_context_usage; the user's message goes in only after they pass.
    const control = (id: string, subtype: string) => child.stdin!.write(JSON.stringify({ type: "control_request", request_id: id, request: { subtype } }) + "\n");
    let mcpStatus: unknown = null;
    /** Claude: the pre-input check passed and the message went in. Required for success. */
    let preflightPassed = false;
    const preflightTimer =
      launch.stdin === "stream-json" ? setTimeout(() => refuse("no answer to the pre-input check"), options.preflightTimeoutMs ?? 15_000) : undefined;
    function onControl(response: any) {
      if (unsafe || !preflightTimer) return;
      if (response?.subtype !== "success") return refuse(`control request ${String(response?.request_id)} failed`);
      const body = response.response;
      if (response.request_id === "defe2end-init") control("defe2end-mcp", "mcp_status");
      else if (response.request_id === "defe2end-mcp") {
        mcpStatus = body;
        control("defe2end-usage", "get_context_usage");
      } else if (response.request_id === "defe2end-usage") {
        clearTimeout(preflightTimer);
        const reason = checkClaudePreflight(mcpStatus, body, allowMcp);
        if (reason) return refuse(reason);
        preflightPassed = true;
        child.stdin!.end(options.input + "\n");
      }
    }
    if (launch.stdin === "stream-json") control("defe2end-init", "initialize");
    else child.stdin!.end(options.input);
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ ok: false, text, error: { code: err.code === "ENOENT" ? "missing" : "failed", message: err.message } });
    });
    child.on("close", async (code) => {
      if (preflightTimer) clearTimeout(preflightTimer);
      if (unsafe) {
        const treeGone = await (stopping ?? killTree(child));
        return finish({ ok: false, text, treeGone, error: { code: "unsafe", message: unsafe } });
      }
      if (stopping || signal?.aborted) {
        const treeGone = await (stopping ?? killTree(child));
        return finish({ ok: false, text, treeGone, error: { code: "stopped", message: "stopped" } });
      }
      // A clean exit without the pre-input check is never a success; a failing exit keeps its own cause (e.g. login).
      if (launch.stdin === "stream-json" && !preflightPassed && code === 0) {
        return finish({ ok: false, text, error: { code: "unsafe", message: "exited before the pre-input check passed" } });
      }
      const detail = failure ?? (code === 0 ? null : stderr.trim() || `exit code ${code}`);
      if (detail !== null) return finish({ ok: false, text, error: { code: isAuthFailure(`${detail}\n${stderr}`) ? "auth" : "failed", message: detail.slice(0, 2000) } });
      finish({ ok: true, text: text || finalText || "" });
    });
  });
}
