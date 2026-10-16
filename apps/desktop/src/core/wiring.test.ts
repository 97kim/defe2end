import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConnectionManager, TEARDOWN_STEPS, type Platform } from "./connection.js";
import { isServerSender, isSetupSender, mainWindowNavigation, parseAuthOrigins } from "./guards.js";

const server = "https://e2e.example.com";
const setupPage = "file:///Applications/defE2End.app/Contents/Resources/app.asar/static/index.html";
const main = { fromMainWindow: true, isMainFrame: true };

describe("IPC sender checks", () => {
  it("accepts the server origin's top frame in the main window only", () => {
    expect(isServerSender({ ...main, frameUrl: `${server}/runs/1` }, server)).toBe(true);
    expect(isServerSender({ ...main, isMainFrame: false, frameUrl: `${server}/x` }, server)).toBe(false);
    expect(isServerSender({ ...main, fromMainWindow: false, frameUrl: `${server}/x` }, server)).toBe(false);
    expect(isServerSender({ ...main, frameUrl: "https://e2e.example.com.evil.test/" }, server)).toBe(false);
    expect(isServerSender({ ...main, frameUrl: "https://accounts.google.com/o" }, server)).toBe(false);
    expect(isServerSender({ ...main, frameUrl: `${server}/` }, null)).toBe(false);
    expect(isServerSender({ ...main, frameUrl: setupPage }, server)).toBe(false);
  });

  it("allows setup from the exact bundled page only", () => {
    expect(isSetupSender({ ...main, frameUrl: `${setupPage}?x#y` }, setupPage)).toBe(true);
    expect(isSetupSender({ ...main, frameUrl: setupPage.replace("index.html", "other.html") }, setupPage)).toBe(false);
    expect(isSetupSender({ ...main, isMainFrame: false, frameUrl: setupPage }, setupPage)).toBe(false);
    expect(isSetupSender({ ...main, frameUrl: `${server}/` }, setupPage)).toBe(false);
  });
});

describe("main window navigation", () => {
  const auth = ["https://accounts.google.com", "https://github.com"];
  it("keeps the server and sign-in origins, sends other web links out, blocks other schemes", () => {
    expect(mainWindowNavigation(`${server}/login`, server, auth)).toBe("allow");
    expect(mainWindowNavigation("https://github.com/login/oauth", server, auth)).toBe("allow");
    expect(mainWindowNavigation("https://docs.example.org/", server, auth)).toBe("external");
    expect(mainWindowNavigation("file:///etc/passwd", server, auth)).toBe("block");
    expect(mainWindowNavigation("javascript:alert(1)", server, auth)).toBe("block");
    expect(mainWindowNavigation("https://github.com/", null, auth)).toBe("external");
  });
  it("keeps well-formed origins from the server config", () => {
    expect(parseAuthOrigins(["https://github.com", "https://a.test/path", "javascript:x", 3, "http://idp.local:8080"])).toEqual(["https://github.com", "http://idp.local:8080"]);
    expect(parseAuthOrigins(null)).toEqual([]);
  });
});

describe("ConnectionManager teardown", () => {
  it("follows the contract section 9 order and signs out of the web first on logout", async () => {
    const calls: string[] = [];
    const platform: Platform = {
      fetchWithCookies: vi.fn(async () => new Response(JSON.stringify({ token: "t", userId: "u", deviceId: "d", expiresAt: "2026-10-20T00:00:00.000Z" }), { status: 200 })),
      fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "DELETE") calls.push("DELETE token");
        // The stream never answers, like a server that holds it open.
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }) as typeof fetch,
      loadToken: async () => null,
      saveToken: async () => {},
      clearToken: async () => void calls.push("clear token"),
      webLogout: async () => void calls.push("web logout"),
      clearServerCookies: async () => void calls.push("clear cookies"),
      clearSideBrowser: async () => void calls.push("clear side browser"),
      stopCaptures: async () => void calls.push("stop captures"),
      runPlan: vi.fn(),
      onUpdateRequired: vi.fn(),
      log: () => {},
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "conn-"));
    const manager = new ConnectionManager(platform, { appVersion: "0.1.0", runnerVersion: "0.1.0", installId: "00000000-0000-4000-8000-000000000000", label: "ab12", dataDir, ownerMark: "t", sandbox: true }, server);
    await manager.connect();
    expect(manager.state).toMatchObject({ userId: "u", deviceId: "d", generation: 0 });
    const steps: string[] = [];
    await manager.teardown("logout", (s) => steps.push(s));
    expect(steps).toEqual([...TEARDOWN_STEPS]);
    expect(calls).toEqual(["stop captures", "DELETE token", "clear token", "web logout", "clear cookies", "clear side browser"]);
    expect(manager.state).toMatchObject({ status: "signed_out", userId: null, generation: 1 });
  });

  it("doesn't install a connection that finished after a teardown began, and can connect again", async () => {
    let releaseExchange!: (res: Response) => void;
    const saved: string[] = [];
    const platform = {
      fetchWithCookies: vi.fn(() => new Promise<Response>((r) => (releaseExchange = r))),
      fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => (init?.method === "DELETE" ? new Response(null, { status: 401 }) : new Promise<Response>(() => {}))) as typeof fetch,
      loadToken: async () => null,
      saveToken: async (_o: string, id: { token: string }) => void saved.push(id.token),
      clearToken: async () => {},
      webLogout: async () => {},
      clearServerCookies: async () => {},
      clearSideBrowser: async () => {},
      stopCaptures: async () => {},
      runPlan: vi.fn(),
      onUpdateRequired: vi.fn(),
      log: vi.fn(),
    } satisfies Platform;
    const dataDir = await mkdtemp(path.join(tmpdir(), "conn-"));
    const manager = new ConnectionManager(platform, { appVersion: "0.1.0", runnerVersion: "0.1.0", installId: "00000000-0000-4000-8000-000000000000", label: "ab12", dataDir, ownerMark: "t", sandbox: true }, server);
    const connecting = manager.connect();
    await new Promise((r) => setTimeout(r, 0));
    const teardown = manager.teardown("account_change");
    releaseExchange(new Response(JSON.stringify({ token: "old", userId: "u1", deviceId: "d", expiresAt: "2026-10-20T00:00:00.000Z" }), { status: 200 }));
    await Promise.all([connecting, teardown]);
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.api).toBeNull();
    expect(saved).toEqual([]);
    expect(platform.log).toHaveBeenCalledWith("token revoke refused: HTTP 401");
    platform.fetchWithCookies.mockImplementation(async () => new Response(JSON.stringify({ token: "new", userId: "u2", deviceId: "d2", expiresAt: "2026-10-20T00:00:00.000Z" }), { status: 200 }));
    await manager.connect();
    expect(manager.state).toMatchObject({ userId: "u2" });
    await manager.quit(10);
  });
});
