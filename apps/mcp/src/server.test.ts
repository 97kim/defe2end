// `defe2end-mcp` against a fake desktop socket (unix socket in a test DIR, or on Windows a named pipe named in the
// DIR's endpoint.txt, as the app writes it; token reader injected).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_OUTPUT_LIMITS, MCP_TOOL_NAMES, parseMcpSocketRequest, type McpSocketRequest } from "@defe2end/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnector, endpointPath, mcpDir } from "./locate.js";
import { createDefe2endMcpServer, detectClient } from "./server.js";

type Handler = (req: Extract<McpSocketRequest, { op: string }>, socket: Socket) => void;

let dir: string;
let fake: NetServer | null;
let received: McpSocketRequest[];
let handler: Handler;
let tokenReads: number;
let closers: Array<() => Promise<void> | void>;

const reply = (socket: Socket, msg: object) => socket.write(JSON.stringify(msg) + "\n");

async function startFake(): Promise<void> {
  fake = createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const req = parseMcpSocketRequest(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (!req || req.token !== "session-token") return void socket.destroy();
        if (req.type === "hello") {
          reply(socket, { id: req.id, ok: true, result: { identity: null } });
          continue;
        }
        received.push(req);
        if (!("op" in req)) {
          reply(socket, { id: req.id, ok: false, error: { code: "cancelled", message: "cancelled" } });
          continue;
        }
        handler(req as Extract<McpSocketRequest, { op: string }>, socket);
      }
    });
  });
  let address = join(dir, "mcp.sock");
  if (process.platform === "win32") {
    address = `\\\\.\\pipe\\d2e-mcp-test-${process.pid}-${Date.now()}`;
    writeFileSync(join(dir, "endpoint.txt"), address);
  }
  await new Promise<void>((r) => fake!.listen(address, r));
}

async function connect(opts: { clientName?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; keys?: string[] } = {}) {
  const env = { DEFE2END_MCP_DIR: dir, ...opts.env };
  const keys = [...(opts.keys ?? [])];
  const { server, close } = createDefe2endMcpServer({
    connector: createConnector({
      env,
      readToken: async () => {
        tokenReads++;
        return "session-token";
      },
    }),
    env,
    timeoutMs: opts.timeoutMs,
    newIdempotencyKey: keys.length ? () => keys.shift()! : undefined,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: opts.clientName ?? "claude-code", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => {
    await client.close();
    close();
  });
  return client;
}

const text = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const calls = () => received.filter((r): r is Extract<McpSocketRequest, { op: string }> => "op" in r);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "d2e-mcp-"));
  received = [];
  tokenReads = 0;
  closers = [];
  handler = (req, socket) => reply(socket, { id: req.id, ok: true, result: { echo: req.op } });
  await startFake();
});
afterEach(async () => {
  for (const c of closers) await c();
  await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()));
  fake = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("tool list", () => {
  it("lists every shared tool with annotations, none destructive, object input schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools).toHaveLength(26);
    for (const t of tools) {
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.inputSchema.type).toBe("object");
    }
    expect(tools.map((t) => t.name)).not.toEqual(expect.arrayContaining(["cancel_run", "stop_all_runs", "delete_schedule", "delete_scenario"]));
    expect(tools.find((t) => t.name === "update_scenario")!.description).toContain("updatedAt");
  });
});

describe("calls", () => {
  it("every tool is one socket op with the tool name, client and token", async () => {
    const client = await connect({ clientName: "codex-mcp-client" });
    const r = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('"echo": "list_workspaces"');
    expect(calls()[0]).toMatchObject({ op: "list_workspaces", client: "codex", token: "session-token", args: {} });
    const b = await client.callTool({ name: "browser_click", arguments: { selector: "#go" } });
    expect(b.isError).toBeFalsy();
    expect(calls()[1]).toMatchObject({ op: "browser_click", args: { selector: "#go" } });
  });

  it("summaries: get_scenario shows updatedAt, run tools show the run id", async () => {
    handler = (req, socket) =>
      reply(socket, {
        id: req.id,
        ok: true,
        result: req.op === "get_scenario" ? { id: "s1", name: "Login", updatedAt: "2026-10-15T01:00:00.000Z", steps: [] } : { runId: "r9", status: "queued" },
      });
    const client = await connect();
    expect(text(await client.callTool({ name: "get_scenario", arguments: { workspaceId: "w1", scenarioId: "s1" } }))).toMatch(/^Scenario Login \(s1\), updatedAt 2026-10-15T01:00:00.000Z/);
    expect(text(await client.callTool({ name: "run_scenario", arguments: { workspaceId: "w1", scenarioId: "s1", environmentId: "e1" } }))).toMatch(/^Run started: r9/);
  });

  it("invalid args are refused before the socket", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "browser_press", arguments: { key: "F5" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^\[invalid-args\]/);
    expect(calls()).toHaveLength(0);
  });

  it("socket errors become tool errors (code, message, keys), redacted", async () => {
    handler = (req, socket) => reply(socket, { id: req.id, ok: false, error: { code: "conflict", message: "ask kim@example.com", keys: ["PASSWORD"] } });
    const client = await connect();
    const r = await client.callTool({ name: "list_sites", arguments: { workspaceId: "w1" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("[conflict] ask [email]\nKeys: PASSWORD");
  });

  it("caps lists at 100 and text at 20,000 characters, and redacts the reply", async () => {
    handler = (req, socket) =>
      reply(socket, {
        id: req.id,
        ok: true,
        result:
          req.op === "list_scenarios"
            ? { scenarios: Array.from({ length: 150 }, (_, i) => ({ id: `s${i}`, owner: "lee@example.com", url: "https://shop.example.com/p?token=abc" })) }
            : { text: "x".repeat(50_000) },
      });
    const client = await connect();
    const list = text(await client.callTool({ name: "list_scenarios", arguments: { workspaceId: "w1" } }));
    expect(list).toContain("scenarios: showing 100 of 150");
    expect(list).toContain('"s99"');
    expect(list).not.toContain('"s100"');
    expect(list).not.toContain("lee@example.com");
    expect(list).not.toContain("token=abc");
    const page = text(await client.callTool({ name: "browser_page_text", arguments: {} }));
    expect(page.length).toBeLessThanOrEqual(MCP_OUTPUT_LIMITS.textChars);
    expect(page).toMatch(/more characters cut\)$/);
  });

  it("screenshot image data is returned as image content, not JSON", async () => {
    handler = (req, socket) => reply(socket, { id: req.id, ok: true, result: { data: "aGVsbG8=", mimeType: "image/jpeg", width: 1024 } });
    const client = await connect();
    const r = (await client.callTool({ name: "browser_screenshot", arguments: {} })) as CallToolResult;
    expect(r.content[1]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" });
    expect(text(r)).not.toContain("aGVsbG8=");
  });
});

describe("client detection", () => {
  it("uses clientInfo, DEFE2END_MCP_CLIENT wins", async () => {
    expect(detectClient("claude-code", {})).toBe("claude");
    expect(detectClient("codex-mcp-client", {})).toBe("codex");
    expect(detectClient("cursor", {})).toBe("unknown");
    expect(detectClient("claude-code", { DEFE2END_MCP_CLIENT: "codex" })).toBe("codex");
    const client = await connect({ clientName: "something", env: { DEFE2END_MCP_CLIENT: "claude" } });
    await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(calls()[0]!.client).toBe("claude");
  });
});

describe("app not reachable", () => {
  it("every tool answers desktop-not-running when there is no socket", async () => {
    await new Promise<void>((r) => fake!.close(() => r()));
    fake = null;
    const client = await connect();
    for (const name of ["list_workspaces", "browser_tabs"]) {
      const r = await client.callTool({ name, arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe("[desktop-not-running] defE2End 앱을 켜고 로그인하세요");
    }
  });

  it("desktop-not-running when the token can't be read", async () => {
    const { server, close } = createDefe2endMcpServer({
      connector: createConnector({ env: { DEFE2END_MCP_DIR: dir }, platform: "darwin", readToken: async () => Promise.reject(new Error("no keychain item")) }),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-code", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    closers.push(async () => {
      await client.close();
      close();
    });
    expect(text(await client.callTool({ name: "list_workspaces", arguments: {} }))).toMatch(/^\[desktop-not-running\]/);
  });

  it("re-reads the token on reconnect after the app drops the connection; idempotent reads retry once", async () => {
    let first = true;
    handler = (req, socket) => {
      if (first) {
        first = false;
        return void socket.destroy();
      }
      reply(socket, { id: req.id, ok: true, result: { workspaces: [] } });
    };
    const client = await connect();
    const r = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(tokenReads).toBe(2);
    expect(calls()).toHaveLength(2);
  });

  it("a non-idempotent call is not resent after a drop", async () => {
    handler = (_req, socket) => void socket.destroy();
    const client = await connect();
    const r = await client.callTool({ name: "browser_click", arguments: { selector: "#a" } });
    expect(text(r)).toMatch(/^\[cancelled\]/);
    expect(calls()).toHaveLength(1);
  });
});

describe("run tools", () => {
  it("send a fresh idempotency key per call and reuse it on a timeout retry", async () => {
    let n = 0;
    handler = (req, socket) => {
      n++;
      if (n === 1) return; // no reply: timeout, then retry
      reply(socket, { id: req.id, ok: true, result: { runId: "r1" } });
    };
    const client = await connect({ timeoutMs: 150, keys: ["key-aaaaaaaaaaaaaaaa", "key-bbbbbbbbbbbbbbbb"] });
    const r = await client.callTool({ name: "run_steps", arguments: { workspaceId: "w1", environmentId: "e1", steps: [{ id: "s1", action: "goto", url: "/" }] } });
    expect(text(r)).toMatch(/^Run started: r1/);
    const runCalls = calls();
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]!.args.idempotencyKey).toBe("key-aaaaaaaaaaaaaaaa");
    expect(runCalls[1]!.args.idempotencyKey).toBe("key-aaaaaaaaaaaaaaaa");
    // The timed-out call was cancelled on the socket.
    expect(received.some((m) => !("op" in m) && m.id === runCalls[0]!.id)).toBe(true);

    await client.callTool({ name: "run_scenario", arguments: { workspaceId: "w1", scenarioId: "s1", environmentId: "e1" } });
    expect(calls()[2]!.args.idempotencyKey).toBe("key-bbbbbbbbbbbbbbbb");
  });

  it("reuse the key when the connection drops mid-call", async () => {
    let n = 0;
    handler = (req, socket) => {
      if (++n === 1) return void socket.destroy();
      reply(socket, { id: req.id, ok: true, result: { runId: "r2" } });
    };
    const client = await connect({ keys: ["key-cccccccccccccccc"] });
    await client.callTool({ name: "run_scenario", arguments: { workspaceId: "w1", scenarioId: "s1", environmentId: "e1" } });
    expect(calls().map((c) => c.args.idempotencyKey)).toEqual(["key-cccccccccccccccc", "key-cccccccccccccccc"]);
  });
});

describe("cancellation", () => {
  it("an MCP request cancel sends cancel { id } on the socket", async () => {
    handler = () => {}; // never replies
    const client = await connect();
    const controller = new AbortController();
    const pending = client.callTool({ name: "browser_page_text", arguments: {} }, undefined, { signal: controller.signal }).catch((e: Error) => e);
    await expect.poll(() => calls().length).toBe(1);
    controller.abort();
    await pending;
    await expect.poll(() => received.find((m) => !("op" in m))).toMatchObject({ type: "cancel", id: calls()[0]!.id, token: "session-token" });
  });
});

describe("locate", () => {
  it("DEFE2END_MCP_DIR wins; defaults per OS; mac socket path; Windows pipe from endpoint.txt", async () => {
    expect(mcpDir({ DEFE2END_MCP_DIR: "/x" }, "darwin")).toBe("/x");
    expect(mcpDir({}, "darwin")).toMatch(/Library\/Application Support\/defE2End\/mcp$/);
    expect(mcpDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toMatch(/defE2End.mcp$/);
    expect(await endpointPath("/d", "darwin")).toBe("/d/mcp.sock");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "endpoint.txt"), "defe2end-mcp-abc\n");
    expect(await endpointPath(dir, "win32")).toBe("\\\\.\\pipe\\defe2end-mcp-abc");
    writeFileSync(join(dir, "endpoint.txt"), "\\\\.\\pipe\\full-name");
    expect(await endpointPath(dir, "win32")).toBe("\\\\.\\pipe\\full-name");
  });
});
