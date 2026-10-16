import { describe, expect, it } from "vitest";
import {
  encodeMcpSocketLine,
  MCP_SOCKET_ERROR_CODES,
  MCP_SOCKET_TIMINGS,
  MCP_TOOL_NAMES,
  mcpSocketArgsSchemas,
  mcpSocketFail,
  mcpSocketOk,
  parseMcpSocketArgs,
  parseMcpSocketRequest,
  parseMcpSocketResponse,
} from "./index.js";

describe("requests", () => {
  it("parses a call with or without type and defaults args", () => {
    expect(parseMcpSocketRequest('{"id":"1","token":"t","op":"browser_tabs"}')).toEqual({ id: "1", token: "t", op: "browser_tabs", args: {} });
    expect(parseMcpSocketRequest('{"type":"call","id":"1","token":"t","op":"get_run","args":{"workspaceId":"w","runId":"r"},"client":"codex"}')).toMatchObject({ type: "call", client: "codex" });
  });

  it("parses a hello and its answer", async () => {
    const { mcpSocketHelloResultSchema } = await import("./mcp-socket.js");
    expect(parseMcpSocketRequest('{"type":"hello","id":"1","token":"t"}')).toEqual({ type: "hello", id: "1", token: "t" });
    expect(parseMcpSocketRequest('{"type":"hello","id":"1","token":"t","op":"x"}')).toBeNull();
    expect(mcpSocketHelloResultSchema.safeParse({ identity: "a".repeat(64) }).success).toBe(true);
    expect(mcpSocketHelloResultSchema.safeParse({ identity: null }).success).toBe(true);
    expect(mcpSocketHelloResultSchema.safeParse({ identity: "user@x.com" }).success).toBe(false);
  });

  it("parses a cancel", () => {
    expect(parseMcpSocketRequest('{"type":"cancel","id":"1","token":"t"}')).toEqual({ type: "cancel", id: "1", token: "t" });
  });

  it("rejects malformed lines (the app then closes the connection)", () => {
    for (const line of ["not json", "{}", '{"id":"1","op":"browser_tabs"}', '{"type":"cancel","id":"1","token":"t","op":"x"}', '{"type":"other","id":"1","token":"t","op":"x"}', '{"id":"1","token":"t","op":"x","extra":1}']) {
      expect(parseMcpSocketRequest(line), line).toBeNull();
    }
  });

  it("round-trips one message per line", () => {
    const line = encodeMcpSocketLine({ id: "1", token: "t", op: "browser_fill", args: { selector: "#a", value: "x\ny" } });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseMcpSocketRequest(line)).toMatchObject({ args: { value: "x\ny" } });
  });
});

describe("args", () => {
  it("answers unknown-op for ops outside the tool list, including destructive ones", () => {
    for (const op of ["cancel_run", "delete_schedule", "stop_all_runs", "browser_tab_close", "__proto__"]) {
      expect(parseMcpSocketArgs(op, {})).toMatchObject({ ok: false, error: { code: "unknown-op" } });
    }
  });

  it("answers invalid-args with the issue paths", () => {
    const r = parseMcpSocketArgs("browser_press", { key: "F5" });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid-args" } });
    if (!r.ok) expect(r.error.message).toContain("key");
  });

  it("requires an idempotency key on run ops only", () => {
    expect(parseMcpSocketArgs("run_scenario", { workspaceId: "w", scenarioId: "s", environmentId: "e" })).toMatchObject({ ok: false, error: { code: "invalid-args" } });
    expect(parseMcpSocketArgs("run_scenario", { workspaceId: "w", scenarioId: "s", environmentId: "e", idempotencyKey: "k1" })).toMatchObject({ ok: true, op: "run_scenario" });
    expect(parseMcpSocketArgs("run_steps", { workspaceId: "w", environmentId: "e", steps: [{ id: "a", action: "goto", url: "https://a.test" }], idempotencyKey: "k" }).ok).toBe(true);
    expect(parseMcpSocketArgs("get_run", { workspaceId: "w", runId: "r", idempotencyKey: "k" }).ok).toBe(false);
  });

  it("has args schemas for every tool", () => {
    expect(Object.keys(mcpSocketArgsSchemas).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });
});

describe("responses", () => {
  it("builds and parses ok and error replies", () => {
    expect(parseMcpSocketResponse(JSON.stringify(mcpSocketOk("1", { tabs: [] })))).toEqual({ id: "1", ok: true, result: { tabs: [] } });
    expect(parseMcpSocketResponse(JSON.stringify(mcpSocketFail("2", "recording-in-progress", "Recording")))).toEqual({ id: "2", ok: false, error: { code: "recording-in-progress", message: "Recording" } });
    expect(mcpSocketFail("3", "conflict", "Missing variables", ["PASSWORD"])).toMatchObject({ error: { keys: ["PASSWORD"] } });
  });

  it("rejects unknown error codes", () => {
    expect(parseMcpSocketResponse('{"id":"1","ok":false,"error":{"code":"boom","message":"x"}}')).toBeNull();
  });

  it("covers the reference codes and the contract's additions", () => {
    for (const code of ["browser-not-open", "tab-not-found", "element-not-found", "element-not-visible", "element-not-clickable", "invalid-selector", "invalid-args", "credential-field", "frame-unreachable", "last-tab", "op-failed", "unknown-op", "recording-in-progress", "scheme-not-allowed", "masking-failed", "desktop-not-running"]) {
      expect(MCP_SOCKET_ERROR_CODES).toContain(code);
    }
  });

  it("keeps get_run waits inside the reply timeout", () => {
    expect(MCP_SOCKET_TIMINGS.replyTimeoutMs).toBe(30_000);
    expect(MCP_SOCKET_TIMINGS.browserOpenWaitMs / MCP_SOCKET_TIMINGS.browserOpenPollMs).toBe(32);
  });
});
