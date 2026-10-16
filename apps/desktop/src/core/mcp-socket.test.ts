import { mkdtemp, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserOps, type BrowserDriver } from "./mcp-browser.js";
import { MCP_KEYCHAIN_SERVICE, prepareMcpEndpoint, type Exec } from "./mcp-endpoint.js";
import { McpRelay, McpTokenManager, type McpTokenRecord, type McpTokenStore } from "./mcp-relay.js";
import { McpOpError, McpSocketServer, type McpOpHandler } from "./mcp-socket-server.js";

const unix = process.platform !== "win32";
const servers: McpSocketServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(handle: McpOpHandler, replyTimeoutMs?: number) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "d2e-mcp-"));
  const endpoint = await prepareMcpEndpoint(dir, process.platform, async () => "");
  const server = new McpSocketServer({ handle, ...(replyTimeoutMs ? { replyTimeoutMs } : {}) });
  servers.push(server);
  await server.listen(endpoint.address);
  await endpoint.secure();
  return { server, endpoint };
}

function client(address: string) {
  const socket = net.connect(address);
  const lines: unknown[] = [];
  let buf = "";
  const closed = new Promise<void>((r) => socket.on("close", () => r()));
  socket.setEncoding("utf8");
  socket.on("data", (c: string) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  socket.on("error", () => {});
  const send = (msg: unknown) => socket.write(JSON.stringify(msg) + "\n");
  const next = async (n = 1) => {
    await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(n), { timeout: 3000 });
    return lines[n - 1] as { id: string; ok: boolean; result?: unknown; error?: { code: string } };
  };
  return { socket, send, next, closed, lines };
}

const pending = (): McpOpHandler => (_op, _args, ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)));

describe("mcp socket server", () => {
  it("answers a valid call and refuses a wrong token by closing without a reply", async () => {
    const { server, endpoint } = await start(async (op) => ({ op }));
    const c = client(endpoint.address);
    c.send({ id: "1", token: server.sessionToken, op: "browser_tabs", args: {} });
    expect(await c.next()).toEqual({ id: "1", ok: true, result: { op: "browser_tabs" } });
    c.send({ id: "2", token: "wrong", op: "browser_tabs", args: {} });
    await c.closed;
    expect(c.lines).toHaveLength(1);
  });

  it("closes on a malformed line and answers unknown-op / invalid-args", async () => {
    const { server, endpoint } = await start(async () => ({}));
    const c = client(endpoint.address);
    c.send({ id: "1", token: server.sessionToken, op: "rm_rf", args: {} });
    expect((await c.next()).error?.code).toBe("unknown-op");
    c.send({ id: "2", token: server.sessionToken, op: "browser_press", args: { key: "Meta" } });
    expect((await c.next(2)).error?.code).toBe("invalid-args");
    c.socket.write("not json\n");
    await c.closed;
  });

  it("cancel stops a running call and answers cancelled", async () => {
    const { server, endpoint } = await start(pending());
    const c = client(endpoint.address);
    c.send({ id: "1", token: server.sessionToken, op: "browser_tabs", args: {} });
    c.send({ type: "cancel", id: "1", token: server.sessionToken });
    expect((await c.next()).error?.code).toBe("cancelled");
  });

  it("times out a call", async () => {
    const { server, endpoint } = await start(pending(), 50);
    const c = client(endpoint.address);
    c.send({ id: "1", token: server.sessionToken, op: "browser_tabs", args: {} });
    expect((await c.next()).error?.code).toBe("timeout");
  });

  it("rotating the session token closes connections and cancels their calls", async () => {
    const aborted: unknown[] = [];
    const { server, endpoint } = await start((_op, _a, ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => (aborted.push(ctx.signal.reason), reject(ctx.signal.reason)))));
    const old = server.sessionToken;
    const c = client(endpoint.address);
    c.send({ id: "1", token: old, op: "browser_tabs", args: {} });
    await vi.waitFor(() => expect(server.connectionCount).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    const fresh = server.rotate();
    expect(fresh).not.toBe(old);
    await c.closed;
    expect(aborted).toHaveLength(1);
    const c2 = client(endpoint.address);
    c2.send({ id: "1", token: old, op: "browser_tabs", args: {} });
    await c2.closed;
  });

  it("closing the connection cancels its calls", async () => {
    let signal: AbortSignal | null = null;
    const { server, endpoint } = await start((_op, _a, ctx) => ((signal = ctx.signal), new Promise(() => {})));
    const c = client(endpoint.address);
    c.send({ id: "1", token: server.sessionToken, op: "browser_tabs", args: {} });
    await vi.waitFor(() => expect(signal).not.toBeNull());
    c.socket.destroy();
    await vi.waitFor(() => expect(signal!.aborted).toBe(true));
  });

  it.runIf(unix)("keeps the folder 0700 and the socket 0600", async () => {
    const { endpoint } = await start(async () => ({}));
    expect((await stat(endpoint.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(endpoint.address)).mode & 0o777).toBe(0o600);
  });

  it.runIf(unix)("publishes the session token to the keychain under the fixed names", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (file, args) => (calls.push([file, ...args]), "");
    const dir = await mkdtemp(path.join(os.tmpdir(), "d2e-mcp-"));
    const endpoint = await prepareMcpEndpoint(dir, "darwin", exec);
    await endpoint.publishToken("tok");
    expect(endpoint.address).toBe(path.join(dir, "mcp", "mcp.sock"));
    expect(calls[0]).toEqual(["security", "add-generic-password", "-U", "-s", MCP_KEYCHAIN_SERVICE, "-a", path.join(dir, "mcp"), "-w", "tok"]);
  });
});

function fakeDriver(over: Partial<BrowserDriver> = {}): BrowserDriver {
  return {
    isRecording: () => false,
    requestOpen: () => {},
    hasTab: () => true,
    tabs: () => [{ id: "tab-1", url: "https://a.test/p?token=abc", title: "mail a@b.co", active: true }],
    navigate: async () => {},
    newTab: async () => ({ id: "tab-2", url: "https://a.test", title: "", active: true }),
    activate: () => {},
    click: async () => {},
    hover: async () => {},
    isCredentialField: async () => false,
    fill: async () => {},
    press: async () => {},
    scroll: async () => {},
    query: async () => [],
    pageText: async () => "",
    maskSensitive: async () => true,
    unmaskSensitive: async () => {},
    screenshot: async () => Buffer.from("png"),
    setAiActive: () => {},
    ...over,
  };
}

const ctx = () => ({ signal: new AbortController().signal });
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof McpOpError ? e.code : String(e)));

describe("browser ops", () => {
  it("refuses while recording, other schemes and password fields", async () => {
    expect(await code(new BrowserOps({ driver: fakeDriver({ isRecording: () => true }) }).call("browser_tabs", {}, ctx()))).toBe("recording-in-progress");
    const ops = new BrowserOps({ driver: fakeDriver({ isCredentialField: async () => true }) });
    expect(await code(ops.call("browser_navigate", { url: "file:///etc/passwd" }, ctx()))).toBe("scheme-not-allowed");
    expect(await code(ops.call("browser_tab_new", { url: "javascript:alert(1)" }, ctx()))).toBe("scheme-not-allowed");
    expect(await code(ops.call("browser_fill", { selector: "#pw", value: "x" }, ctx()))).toBe("credential-field");
  });

  it("redacts DOM replies, page text and tab URLs", async () => {
    const ops = new BrowserOps({
      driver: fakeDriver({
        query: async () => [{ tag: "input", text: "call 010-1234-5678", outerHtml: '<input name="email" value="secret@x.com" data-token="abcd1234efgh5678">', visible: true }],
        pageText: async () => "contact me@example.com",
      }),
    });
    const dom = (await ops.call("browser_query_dom", { selector: "input", includeHtml: true }, ctx())) as { elements: { text: string; html: string }[] };
    expect(dom.elements[0]!.html).not.toContain("secret@x.com");
    expect(dom.elements[0]!.html).not.toContain("abcd1234efgh5678");
    expect(dom.elements[0]!.text).not.toContain("010-1234-5678");
    expect(((await ops.call("browser_page_text", {}, ctx())) as { text: string }).text).not.toContain("me@example.com");
    const tabs = (await ops.call("browser_tabs", {}, ctx())) as { tabs: { url: string; title: string }[] };
    expect(tabs.tabs[0]!.url).not.toContain("abc");
    expect(tabs.tabs[0]!.title).not.toContain("a@b.co");
  });

  it("refuses a screenshot when masking can't be confirmed", async () => {
    const unmask = vi.fn(async () => {});
    const shot = vi.fn(async () => Buffer.from(""));
    const ops = new BrowserOps({ driver: fakeDriver({ maskSensitive: async () => false, unmaskSensitive: unmask, screenshot: shot }) });
    expect(await code(ops.call("browser_screenshot", {}, ctx()))).toBe("masking-failed");
    expect(shot).not.toHaveBeenCalled();
  });

  it("opens the side browser and gives up after the wait", async () => {
    const requestOpen = vi.fn();
    let polls = 0;
    const ops = new BrowserOps({ driver: fakeDriver({ hasTab: () => false, requestOpen }), sleep: async () => void polls++ });
    vi.useFakeTimers({ toFake: ["Date"] });
    const p = code(ops.call("browser_tabs", {}, ctx()));
    vi.setSystemTime(Date.now() + 9_000);
    expect(await p).toBe("browser-not-open");
    vi.useRealTimers();
    expect(requestOpen).toHaveBeenCalledOnce();
  });

  it("shows the AI sign while acting", async () => {
    const states: boolean[] = [];
    const ops = new BrowserOps({ driver: fakeDriver({ setAiActive: (a) => states.push(a) }), aiSignHoldMs: 40 });
    await ops.call("browser_click", { selector: "#b" }, ctx());
    expect(states).toEqual([true]); // held on after a quick op
    await ops.call("browser_click", { selector: "#b" }, ctx()); // a follow-up within the hold keeps it on
    expect(states).toEqual([true]);
    await new Promise((r) => setTimeout(r, 80));
    expect(states).toEqual([true, false]);
  });
});

function memoryStore(failSave = false): McpTokenStore & { saved: McpTokenRecord[] } {
  const saved: McpTokenRecord[] = [];
  return {
    saved,
    load: async () => saved.at(-1) ?? null,
    save: async (_k, r) => {
      if (failSave) throw new Error("no keychain");
      saved.push(r);
    },
    clear: async () => void saved.splice(0),
  };
}

const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status });
const DAY = 24 * 60 * 60 * 1000;

describe("mcp token manager", () => {
  const base = { origin: "https://s.test", userId: "u", deviceId: "d", installId: "i", desktopToken: () => "desk_t", signal: new AbortController().signal };

  it("issues with cookies, then refreshes 7 days before expiry and uses the new token once stored", async () => {
    const now = Date.parse("2026-10-15T00:00:00Z");
    const store = memoryStore();
    store.saved.push({ token: "mcp_old", expiresAt: new Date(now + 3 * DAY).toISOString(), deviceId: "d" });
    const fetch = vi.fn(async () => json(201, { token: "mcp_new", expiresAt: new Date(now + 30 * DAY).toISOString() }));
    const m = new McpTokenManager({ ...base, store, fetch, fetchWithCookies: vi.fn(), now: () => now });
    expect((await m.token()).token).toBe("mcp_new");
    expect(store.saved.at(-1)!.token).toBe("mcp_new");
  });

  it("keeps the old token when the new one can't be stored", async () => {
    const now = Date.parse("2026-10-15T00:00:00Z");
    const store = memoryStore(true);
    const old = { token: "mcp_old", expiresAt: new Date(now + 3 * DAY).toISOString(), deviceId: "d" };
    store.load = async () => old;
    const fetch = vi.fn(async () => json(201, { token: "mcp_new", expiresAt: new Date(now + 30 * DAY).toISOString() }));
    const m = new McpTokenManager({ ...base, store, fetch, fetchWithCookies: vi.fn(), now: () => now });
    expect((await m.token()).token).toBe("mcp_old");
    expect((await m.token()).token).toBe("mcp_old");
    expect(fetch).toHaveBeenCalledTimes(2); // tries again
  });

  it("issues a token when none is stored", async () => {
    const fetchWithCookies = vi.fn(async () => json(201, { token: "mcp_a", expiresAt: new Date(Date.now() + 30 * DAY).toISOString(), deviceId: "d" }));
    const m = new McpTokenManager({ ...base, store: memoryStore(), fetch: vi.fn(), fetchWithCookies });
    expect((await m.token()).token).toBe("mcp_a");
    expect((fetchWithCookies.mock.calls[0] as unknown[])[0]).toBe("https://s.test/api/desktop/mcp-token");
    expect(JSON.parse(String(((fetchWithCookies.mock.calls[0] as unknown[])[1] as RequestInit).body))).toEqual({ installId: "i", desktopToken: "desk_t" });
  });

  it("doesn't ask for a token without a live desktop token", async () => {
    const fetchWithCookies = vi.fn();
    const m = new McpTokenManager({ ...base, desktopToken: () => null, store: memoryStore(), fetch: vi.fn(), fetchWithCookies });
    await expect(m.token()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(fetchWithCookies).not.toHaveBeenCalled();
  });
});

describe("relay", () => {
  const tokens = { token: async () => ({ token: "mcp_t", expiresAt: "", deviceId: "d" }), invalidate: () => {} };
  const workspaces = json(200, { workspaces: [{ id: "w1", slug: "acme" }] });

  it("maps ops to /api/mcp routes with the client header and idempotency key", async () => {
    const calls: [string, RequestInit][] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init!]);
      return String(url).endsWith("/workspaces") ? workspaces.clone() : json(201, { id: "r1" });
    });
    const relay = new McpRelay({ origin: "https://s.test", tokens, fetch, deviceId: "dev" });
    await relay.call("run_scenario", { workspaceId: "w1", scenarioId: "s1", environmentId: "e1", location: "desktop", idempotencyKey: "k1" }, { signal: new AbortController().signal, client: "codex" });
    const [url, init] = calls.at(-1)!;
    expect(url).toBe("https://s.test/api/mcp/w/acme/runs");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Defe2end-Client"]).toBe("codex");
    expect(headers["Idempotency-Key"]).toBe("k1");
    expect(headers.Authorization).toBe("Bearer mcp_t");
    expect(JSON.parse(init.body as string)).toEqual({ scenarioId: "s1", environmentId: "e1", location: "desktop", deviceId: "dev" });
  });

  it("passes update_scenario's updatedAt through and leaves the client header out when unknown", async () => {
    const calls: [string, RequestInit][] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => (calls.push([String(url), init!]), String(url).endsWith("/workspaces") ? workspaces.clone() : json(200, {})));
    const relay = new McpRelay({ origin: "https://s.test", tokens, fetch, deviceId: "dev" });
    await relay.call("update_scenario", { workspaceId: "w1", scenarioId: "s1", updatedAt: "2026-10-15T00:00:00.000Z", name: "n" }, { signal: new AbortController().signal, client: "unknown" });
    const [url, init] = calls.at(-1)!;
    expect(url).toBe("https://s.test/api/mcp/w/acme/scenarios/s1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ updatedAt: "2026-10-15T00:00:00.000Z", name: "n" });
    expect((init.headers as Record<string, string>)["X-Defe2end-Client"]).toBeUndefined();
  });

  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not-found"],
    [409, "conflict"],
    [500, "server-unavailable"],
    [503, "server-unavailable"],
  ])("maps HTTP %i to %s", async (status, expected) => {
    const fetch = vi.fn(async (url: string | URL | Request) => (String(url).endsWith("/workspaces") ? workspaces.clone() : json(status, { error: { code: "x", message: "m" } })));
    const relay = new McpRelay({ origin: "https://s.test", tokens, fetch, deviceId: "dev" });
    expect(await code(relay.call("get_scenario", { workspaceId: "w1", scenarioId: "s1" }, ctx()))).toBe(expected);
  });

  it("maps a connection failure to server-unavailable and an unknown workspace to not-found", async () => {
    const down = new McpRelay({ origin: "https://s.test", tokens, fetch: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))), deviceId: "d" });
    expect(await code(down.call("list_workspaces", {}, ctx()))).toBe("server-unavailable");
    const relay = new McpRelay({ origin: "https://s.test", tokens, fetch: vi.fn(async () => workspaces.clone()), deviceId: "d" });
    expect(await code(relay.call("list_sites", { workspaceId: "other" }, ctx()))).toBe("not-found");
  });
});

describe("review fixes", () => {
  it("query_dom text leaves out textarea and sensitive select content (built from the redacted DOM)", async () => {
    const ops = new BrowserOps({
      driver: fakeDriver({
        query: async () => [
          {
            tag: "form",
            text: "my secret note 4111 card",
            outerHtml: '<form><label>Note</label><textarea>my secret note</textarea><select autocomplete="cc-exp-month"><option selected>4111</option></select><b>Pay</b></form>',
            visible: true,
          },
        ],
      }),
    });
    const res = (await ops.call("browser_query_dom", { selector: "form" }, ctx())) as { elements: { text: string }[] };
    expect(res.elements[0]!.text).toBe("Note Pay");
  });

  it("refuses the screenshot when a frame can't be checked or a box isn't on top", async () => {
    const { maskVerdict } = await import("./mcp-browser.js");
    expect(maskVerdict({ inputs: 0, covered: 0, unreachableFrames: 0 })).toBe(true);
    expect(maskVerdict({ inputs: 0, covered: 0, unreachableFrames: 1 })).toBe(false);
    expect(maskVerdict({ inputs: 2, covered: 1, unreachableFrames: 0 })).toBe(false);
    expect(maskVerdict(null)).toBe(false);
  });

  it("a failed keychain write reports a code, never the token", async () => {
    const { TokenPublisher } = await import("./mcp-endpoint.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "d2e-mcp-"));
    const exec: Exec = async (file, args) => Promise.reject(Object.assign(new Error(`Command failed: ${file} ${args.join(" ")}`), { code: 45 }));
    const endpoint = await prepareMcpEndpoint(dir, "darwin", exec);
    const err = await endpoint.publishToken("tok-SECRET").catch((e: Error) => e);
    expect(String(err)).not.toContain("tok-SECRET");
    const codes: string[] = [];
    const publisher = new TokenPublisher(endpoint, (c) => codes.push(c));
    publisher.publish("tok-SECRET");
    await publisher.idle();
    expect(codes).toEqual(["security:45"]);
  });

  it("writes session tokens in order and drops a replaced one", async () => {
    const { TokenPublisher } = await import("./mcp-endpoint.js");
    const written: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const publisher = new TokenPublisher({ publishToken: async (t) => (t === "a" ? first : Promise.resolve()).then(() => void written.push(t)) }, () => {});
    publisher.publish("a");
    await new Promise((r) => setTimeout(r, 0)); // "a" is being written
    publisher.publish("b");
    publisher.publish("c");
    release();
    await publisher.idle();
    await publisher.close();
    publisher.publish("d"); // after close: nothing
    await publisher.idle();
    expect(written).toEqual(["a", "c"]);
  });

  it.runIf(unix)("stops the old AI work only when the signed-in identity changes, and tells it via hello", async () => {
    const { McpHost } = await import("./mcp-host.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "d2e-host-"));
    type S = import("./connection.js").ConnectionState;
    let state: S = { status: "connected", origin: "https://s.test", userId: "a", deviceId: "d", generation: 0 };
    const listeners = new Set<(s: S) => void>();
    const onIdentityChange = vi.fn();
    const host = new McpHost({
      userData: dir,
      installId: "i",
      state: () => state,
      onState: (l) => (listeners.add(l), () => listeners.delete(l)),
      desktopToken: () => "desk_t",
      fetchWithCookies: vi.fn(),
      fetch: vi.fn(),
      driver: fakeDriver(),
      tokenStore: memoryStore(),
      onIdentityChange,
      log: () => {},
      exec: async () => "",
    });
    await host.start();
    const first = host.sessionToken;
    expect(onIdentityChange).not.toHaveBeenCalled();
    // Same account reconnecting in a new generation: new token, the conversation goes on.
    state = { ...state, generation: 1 };
    for (const l of listeners) l(state);
    expect(host.sessionToken).not.toBe(first);
    expect(onIdentityChange).not.toHaveBeenCalled();
    const { mcpIdentity } = await import("./mcp-socket-server.js");
    const c = client(path.join(dir, "mcp", "mcp.sock"));
    c.send({ type: "hello", id: "h", token: host.sessionToken });
    expect(await c.next()).toEqual({ id: "h", ok: true, result: { identity: mcpIdentity("https://s.test", "a") } });
    // Another account: chats stop.
    state = { ...state, userId: "b", generation: 2 };
    for (const l of listeners) l(state);
    expect(onIdentityChange).toHaveBeenCalledOnce();
    await c.closed;
    await host.stop();
  });
});

describe("review fixes 2", () => {
  it("refuses a screenshot when an input can't be placed for sure (transformed frame)", async () => {
    const { maskVerdict } = await import("./mcp-browser.js");
    expect(maskVerdict({ inputs: 1, covered: 0, unreachableFrames: 0, uncertain: 1 })).toBe(false);
    expect(maskVerdict({ inputs: 1, covered: 1, unreachableFrames: 0, uncertain: 0 })).toBe(true);
  });

  it("never returns an unfinished tag when cutting long HTML", async () => {
    const { cutHtml } = await import("./mcp-browser.js");
    const long = `<div>${"x".repeat(1990)}<input title="${"s".repeat(100)}"></div>`;
    const cut = cutHtml(long, 2000);
    expect(cut.length).toBeLessThanOrEqual(2000);
    expect(cut).not.toContain("<input");
    expect(cut.endsWith("x")).toBe(true);
    const ops = new BrowserOps({ driver: fakeDriver({ query: async () => [{ tag: "div", outerHtml: long, visible: true }] }) });
    const res = (await ops.call("browser_query_dom", { selector: "div", includeHtml: true }, ctx())) as { elements: { html: string }[] };
    expect(res.elements[0]!.html).not.toMatch(/<[^>]*$/);
  });
});
