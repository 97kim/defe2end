import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, CHECK_INTERVAL_MS, FIRST_CHECK_MS, LATEST_RELEASE_URL, newerRelease, scheduleUpdateChecks } from "./update-check";

const release = (tag: string, extra: object = {}) => ({ tag_name: tag, html_url: `https://github.com/97kim/defe2end/releases/tag/${tag}`, draft: false, prerelease: false, ...extra });

describe("newerRelease", () => {
  it("reports a newer published release", () => {
    expect(newerRelease("1.0.0", release("v1.1.0"))).toEqual({ version: "1.1.0", url: "https://github.com/97kim/defe2end/releases/tag/v1.1.0" });
    expect(newerRelease("1.0.0-rc.2", release("v1.0.0"))?.version).toBe("1.0.0");
  });
  it("ignores the same or an older version", () => {
    expect(newerRelease("1.1.0", release("v1.1.0"))).toBeNull();
    expect(newerRelease("1.2.0", release("v1.1.9"))).toBeNull();
  });
  it("ignores pre-releases, drafts and odd tags", () => {
    expect(newerRelease("1.0.0", release("v1.1.0-rc.1"))).toBeNull();
    expect(newerRelease("1.0.0", release("v1.1.0", { prerelease: true }))).toBeNull();
    expect(newerRelease("1.0.0", release("v1.1.0", { draft: true }))).toBeNull();
    expect(newerRelease("1.0.0", release("1.1.0"))).toBeNull();
    expect(newerRelease("1.0.0", null)).toBeNull();
  });
  it("links only to the releases page", () => {
    expect(newerRelease("1.0.0", release("v1.1.0", { html_url: "https://example.com/x" }))?.url).toBe("https://github.com/97kim/defe2end/releases/tag/v1.1.0");
  });
});

describe("checkForUpdate", () => {
  it("asks the public API without credentials or identifiers", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(release("v2.0.0")), { status: 200 }));
    expect(await checkForUpdate("1.0.0", fetchImpl as unknown as typeof fetch)).toMatchObject({ version: "2.0.0" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LATEST_RELEASE_URL);
    expect(Object.keys(init.headers as object)).toEqual(["accept"]);
    expect(init.credentials).toBe("omit");
  });
  it("stays quiet on network failures and bad answers", async () => {
    expect(await checkForUpdate("1.0.0", (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toBeNull();
    expect(await checkForUpdate("1.0.0", (async () => new Response("rate limited", { status: 403 })) as unknown as typeof fetch)).toBeNull();
    expect(await checkForUpdate("1.0.0", (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch)).toBeNull();
  });
});

describe("scheduleUpdateChecks", () => {
  afterEach(() => vi.useRealTimers());
  it("checks 60 seconds after start, then daily, and not while turned off", async () => {
    vi.useFakeTimers();
    let enabled = true;
    const check = vi.fn(async () => undefined);
    const stop = scheduleUpdateChecks(() => enabled, check);
    vi.advanceTimersByTime(FIRST_CHECK_MS - 1);
    expect(check).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(check).toHaveBeenCalledTimes(1);
    enabled = false;
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(1);
    enabled = true;
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
  });
  it("turned off before the first check, never asks", () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => undefined);
    scheduleUpdateChecks(() => false, check);
    vi.advanceTimersByTime(FIRST_CHECK_MS + CHECK_INTERVAL_MS);
    expect(check).not.toHaveBeenCalled();
  });
});
