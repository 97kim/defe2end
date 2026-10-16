import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageState } from "@defe2end/shared";
import { HttpError } from "./api-client.js";
import { CaptureController, registerAuthSession, siteStorageState, type CaptureWindow } from "./auth-state.js";

afterEach(() => vi.useRealTimers());

describe("siteStorageState", () => {
  const cookies = [
    { name: "sid", value: "secret-1", domain: "shop.example.com", path: "/", session: true, sameSite: "unspecified" as const },
    { name: "pref", value: "v", domain: ".example.com", path: "/", expirationDate: 1_900_000_000.7, sameSite: "no_restriction" as const, secure: true },
    { name: "other", value: "x", domain: ".ads.test", path: "/" },
    { name: "sibling", value: "y", domain: "api.example.com", path: "/" },
  ];
  it("keeps host and parent-domain cookies, maps SameSite and session expiry, adds the origin's localStorage", () => {
    expect(siteStorageState("https://shop.example.com/cart", cookies, [{ name: "k", value: "v" }])).toEqual({
      cookies: [
        { name: "sid", value: "secret-1", domain: "shop.example.com", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
        { name: "pref", value: "v", domain: ".example.com", path: "/", expires: 1_900_000_000, httpOnly: false, secure: true, sameSite: "None" },
      ],
      origins: [{ origin: "https://shop.example.com", localStorage: [{ name: "k", value: "v" }] }],
    });
  });
  it("saves nothing without a cookie of the site, and only cookies when localStorage is unreadable", () => {
    expect(siteStorageState("https://other.test/", cookies, [{ name: "k", value: "v" }])).toBeNull();
    expect(siteStorageState("https://shop.example.com/", cookies, null)?.origins).toEqual([]);
  });
});

describe("registerAuthSession", () => {
  const body = { workspaceId: "w", environmentId: "e", storageState: { cookies: [], origins: [] } };
  it("retries once 2 s later, but not a refusal", async () => {
    const sleep = vi.fn(async () => {});
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError("network")).mockResolvedValueOnce({});
    await registerAuthSession({ json: flaky }, body, sleep);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
    const refused = vi.fn().mockRejectedValue(new HttpError(409, {}));
    await expect(registerAuthSession({ json: refused }, body, sleep)).rejects.toBeInstanceOf(HttpError);
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

function fakeWindow(states: (StorageState | null)[]) {
  let closing: (() => Promise<void>) | null = null;
  const win: CaptureWindow & { userCloses(): Promise<void>; closed: boolean } = {
    closed: false,
    snapshot: vi.fn(async () => states.shift() ?? null),
    onClosing: (l) => void (closing = l),
    close: () => void (win.closed = true),
    userCloses: async () => closing!(),
  };
  return win;
}
const state = (n: number): StorageState => ({ cookies: Array.from({ length: n }, (_, i) => ({ name: `c${i}`, value: "v", domain: "a.test", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" })), origins: [] });
const request = { requestId: "q1", workspaceId: "w", environmentId: "e", url: "https://a.test/" };

describe("CaptureController", () => {
  it("snapshots every 2.5 s and registers the last one with cookies when the window closes", async () => {
    vi.useFakeTimers();
    const win = fakeWindow([state(1), state(2), state(0)]);
    const register = vi.fn(async () => {});
    const captures = new CaptureController({ open: () => win, log: () => {} });
    captures.start(request, { register, current: () => true });
    await vi.advanceTimersByTimeAsync(5_000);
    await win.userCloses();
    await vi.advanceTimersByTimeAsync(0);
    expect(win.snapshot).toHaveBeenCalledTimes(3);
    expect(register).toHaveBeenCalledWith({ workspaceId: "w", environmentId: "e", requestId: "q1", storageState: state(2) });
  });

  it("returns a schedule or bot target unchanged on registration", async () => {
    vi.useFakeTimers();
    const win = fakeWindow([state(1)]);
    const register = vi.fn(async () => {});
    const captures = new CaptureController({ open: () => win, log: () => {} });
    captures.start({ ...request, target: { kind: "schedule", scheduleId: "s1" } }, { register, current: () => true });
    await win.userCloses();
    await vi.advanceTimersByTimeAsync(0);
    expect(register).toHaveBeenCalledWith({ workspaceId: "w", environmentId: "e", requestId: "q1", target: { kind: "schedule", scheduleId: "s1" }, storageState: state(1) });
  });

  it("drops the current capture without registering on a new request or stop", async () => {
    vi.useFakeTimers();
    const first = fakeWindow([state(1)]);
    const second = fakeWindow([]);
    const wins = [first, second];
    const register = vi.fn(async () => {});
    const captures = new CaptureController({ open: () => wins.shift()!, log: () => {} });
    captures.start(request, { register, current: () => true });
    await vi.advanceTimersByTimeAsync(2_500);
    captures.start({ ...request, requestId: "q2" }, { register, current: () => true });
    expect(first.closed).toBe(true);
    await first.userCloses();
    captures.stop();
    expect(second.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(register).not.toHaveBeenCalled();
  });

  it("never registers through another generation, even when it changes while the window is closing", async () => {
    vi.useFakeTimers();
    let generation = 0;
    const win = fakeWindow([state(1), state(1)]);
    const registerA = vi.fn(async () => {});
    const captures = new CaptureController({ open: () => win, log: () => {} });
    captures.start(request, { register: registerA, current: () => generation === 0 });
    await vi.advanceTimersByTimeAsync(2_500);
    const closing = win.userCloses();
    generation = 1;
    captures.stop();
    await closing;
    await vi.advanceTimersByTimeAsync(0);
    expect(registerA).not.toHaveBeenCalled();
  });

  it("keeps a closing capture cancellable until its registration is done", async () => {
    vi.useFakeTimers();
    const win = fakeWindow([state(1)]);
    let release!: () => void;
    const register = vi.fn(() => new Promise<void>((r) => (release = r)));
    const captures = new CaptureController({ open: () => win, log: () => {} });
    captures.start(request, { register, current: () => true });
    await win.userCloses();
    await vi.advanceTimersByTimeAsync(0);
    expect(register).toHaveBeenCalledTimes(1);
    captures.stop();
    expect(win.closed).toBe(true);
    release();
  });
});
