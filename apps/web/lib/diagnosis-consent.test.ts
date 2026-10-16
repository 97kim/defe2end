import { describe, expect, it, vi } from "vitest";
import { CONSENT_URL, hasConsent, LEGACY_CONSENT_KEY, recordConsent, sendLock } from "./diagnosis-consent";

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("hasConsent", () => {
  it("follows the server's value only", async () => {
    expect(await hasConsent(answer(200, { consentedAt: "2026-10-16T08:00:00.000Z" }), undefined)).toBe(true);
    expect(await hasConsent(answer(200, { consentedAt: null }), undefined)).toBe(false);
  });

  it("counts a failed or odd answer as no consent", async () => {
    expect(await hasConsent(answer(500, { consentedAt: "x" }), undefined)).toBe(false);
    expect(await hasConsent(vi.fn(async () => new Response("not json")), undefined)).toBe(false);
    expect(await hasConsent(vi.fn(() => Promise.reject(new Error("offline"))), undefined)).toBe(false);
  });

  it("drops a browser-only consent without moving it to the server", async () => {
    const fetcher = answer(200, { consentedAt: null });
    const storage = { removeItem: vi.fn() };
    expect(await hasConsent(fetcher, storage)).toBe(false);
    expect(storage.removeItem).toHaveBeenCalledWith(LEGACY_CONSENT_KEY);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(CONSENT_URL, { cache: "no-store" });
  });
});

describe("recordConsent", () => {
  it("is true only when the server saved it", async () => {
    expect(await recordConsent(answer(200, { consentedAt: "t" }))).toBe(true);
    expect(await recordConsent(answer(401, {}))).toBe(false);
    expect(await recordConsent(vi.fn(() => Promise.reject(new Error("offline"))))).toBe(false);
  });
});

describe("sendLock", () => {
  it("lets one send through until it is released", () => {
    const lock = sendLock();
    expect(lock.claim()).toBe(true);
    expect(lock.claim()).toBe(false);
    lock.release();
    expect(lock.claim()).toBe(true);
  });

  it("keeps a second send out while the first awaits the consent check", async () => {
    const lock = sendLock();
    let started = 0;
    let answer!: (ok: boolean) => void;
    const send = async () => {
      if (!lock.claim()) return;
      try {
        if (!(await new Promise<boolean>((r) => (answer = r)))) return;
        started++;
      } finally {
        lock.release();
      }
    };
    const first = send();
    await send();
    answer(true);
    await first;
    expect(started).toBe(1);
    await Promise.all([send(), Promise.resolve().then(() => answer(false))]);
    expect(started).toBe(1);
    expect(lock.claim()).toBe(true);
  });
});
