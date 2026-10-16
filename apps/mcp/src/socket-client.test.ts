import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppSocketClient } from "./socket-client.js";

const servers: net.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** Like the app: drops a wrong token, answers `hello` with the current identity, echoes calls. */
async function fakeApp(app: { token: string; identity: string | null }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "d2e-sc-"));
  const address = process.platform === "win32" ? `\\\\.\\pipe\\d2e-sc-${Date.now()}` : path.join(dir, "s.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const req = JSON.parse(buf.slice(0, nl)) as { type?: string; id: string; token: string };
        buf = buf.slice(nl + 1);
        if (req.token !== app.token) return void s.destroy();
        const result = req.type === "hello" ? { identity: app.identity } : { as: app.identity };
        s.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(address, r));
  // An app restart or generation change: new token, every connection closed.
  const rotate = (next: { token: string; identity: string | null }) => {
    Object.assign(app, next);
    sockets.forEach((s) => s.destroy());
  };
  return { address, rotate };
}

const A = "a".repeat(64);
const B = "b".repeat(64);
const opts = { client: "claude" as const, retryOnDrop: true, retryOnTimeout: false };

describe("identity pinning", () => {
  it("keeps working with a new token for the same identity (app restart)", async () => {
    const app = { token: "t1", identity: A as string | null };
    const fake = await fakeApp(app);
    const client = new AppSocketClient(async () => ({ path: fake.address, token: app.token }));
    expect(await client.call("browser_tabs", {}, opts)).toEqual({ ok: true, result: { as: A } });
    fake.rotate({ token: "t2", identity: A });
    expect(await client.call("browser_tabs", {}, opts)).toEqual({ ok: true, result: { as: A } });
    client.close();
  });

  it("ends every call with unauthenticated once another identity answers", async () => {
    const app = { token: "t1", identity: A as string | null };
    const fake = await fakeApp(app);
    const client = new AppSocketClient(async () => ({ path: fake.address, token: app.token }));
    expect((await client.call("browser_tabs", {}, opts)).ok).toBe(true);
    fake.rotate({ token: "t2", identity: B });
    const after = await client.call("browser_tabs", {}, opts);
    expect(!after.ok && after.error.code).toBe("unauthenticated");
    fake.rotate({ token: "t3", identity: A }); // even back to A: this process stays ended
    const again = await client.call("browser_tabs", {}, opts);
    expect(!again.ok && again.error.code).toBe("unauthenticated");
    client.close();
  });

  it("pins the first signed-in identity when it started signed out", async () => {
    const app = { token: "t1", identity: null as string | null };
    const fake = await fakeApp(app);
    const client = new AppSocketClient(async () => ({ path: fake.address, token: app.token }));
    expect((await client.call("browser_tabs", {}, opts)).ok).toBe(true);
    fake.rotate({ token: "t2", identity: B });
    expect(await client.call("browser_tabs", {}, opts)).toEqual({ ok: true, result: { as: B } });
    fake.rotate({ token: "t3", identity: A });
    const after = await client.call("browser_tabs", {}, opts);
    expect(!after.ok && after.error.code).toBe("unauthenticated");
    client.close();
  });
});

describe("cancel and overall time limit", () => {
  /** Accepts connections but never answers (not even `hello`). */
  async function silentApp() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "d2e-sc-"));
    const address = process.platform === "win32" ? `\\\\.\\pipe\\d2e-silent-${Date.now()}` : path.join(dir, "s.sock");
    const server = net.createServer(() => {});
    servers.push(server);
    await new Promise<void>((r) => server.listen(address, r));
    return address;
  }

  it("a cancel during connect/hello ends the call at once", async () => {
    const address = await silentApp();
    const client = new AppSocketClient(async () => ({ path: address, token: "t" }), 30_000);
    const controller = new AbortController();
    const started = Date.now();
    const p = client.call("browser_tabs", {}, { ...opts, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const res = await p;
    expect(!res.ok && res.error.code).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(1_000);
    client.close();
  });

  it("connect, hello, call and retries share one time budget", async () => {
    const address = await silentApp();
    const client = new AppSocketClient(async () => ({ path: address, token: "t" }), 300);
    const started = Date.now();
    const res = await client.call("browser_tabs", {}, { ...opts, retryOnTimeout: true });
    expect(res.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    client.close();
  });
});
