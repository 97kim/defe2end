import { describe, expect, it } from "vitest";
import { clearDraft, draftFailureNotice, draftKey, isStaleDraft, loadDraft, saveDraft, type ScenarioDraft } from "./scenario-draft";

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const draft: ScenarioDraft = {
  baseUpdatedAt: "2026-10-11T05:00:00.000Z",
  name: "Checkout edited",
  description: "",
  siteId: "site-1",
  steps: [{ id: "s1", action: "goto", url: "/edited" }],
};

describe("scenario drafts", () => {
  it("keys by workspace, scenario and user", () => {
    expect(draftKey("shop-web", "abc", "u1")).not.toBe(draftKey("other", "abc", "u1"));
    expect(draftKey("shop-web", "abc", "u1")).not.toBe(draftKey("shop-web", "abd", "u1"));
    expect(draftKey("shop-web", "abc", "u1")).not.toBe(draftKey("shop-web", "abc", "u2"));
    expect(draftKey("shop-web", "abc", "u1")).toBe(draftKey("shop-web", "abc", "u1"));
  });

  it("never restores another account's draft in the same tab", () => {
    const store = memoryStore();
    saveDraft(store, draftKey("w", "a", "alice"), draft);
    expect(loadDraft(store, draftKey("w", "a", "bob"))).toBeNull();
    expect(loadDraft(store, draftKey("w", "a", "alice"))).toEqual(draft);
  });

  it("restores what was saved, per key", () => {
    const store = memoryStore();
    expect(saveDraft(store, draftKey("w", "a", "u"), draft)).toBe(true);
    expect(loadDraft(store, draftKey("w", "a", "u"))).toEqual(draft);
    expect(loadDraft(store, draftKey("w", "b", "u"))).toBeNull();
    expect(loadDraft(null, draftKey("w", "a", "u"))).toBeNull();
  });

  it("detects a stale base (the server version moved on)", () => {
    expect(isStaleDraft(draft, draft.baseUpdatedAt)).toBe(false);
    expect(isStaleDraft(draft, "2026-10-11T06:00:00.000Z")).toBe(true);
  });

  it("clears, and drops corrupt entries on load", () => {
    const store = memoryStore();
    const key = draftKey("w", "a", "u");
    saveDraft(store, key, draft);
    clearDraft(store, key);
    expect(loadDraft(store, key)).toBeNull();
    store.setItem(key, "{not json");
    expect(loadDraft(store, key)).toBeNull();
    expect(store.data.has(key)).toBe(false);
    store.setItem(key, JSON.stringify({ name: "x" }));
    expect(loadDraft(store, key)).toBeNull();
    expect(store.data.has(key)).toBe(false);
  });

  it("reports a store that refuses writes, or no store at all, without throwing", () => {
    const full = { ...memoryStore(), setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(saveDraft(full, draftKey("w", "a", "u"), draft)).toBe(false);
    expect(saveDraft(null, draftKey("w", "a", "u"), draft)).toBe(false);
  });

  it("notifies once per session on failed saves, never on successful ones", () => {
    let notices = 0;
    const report = draftFailureNotice(() => notices++);
    report(true);
    expect(notices).toBe(0);
    report(false);
    report(false);
    report(true);
    report(false);
    expect(notices).toBe(1);
  });
});
