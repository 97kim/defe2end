// Unsaved scenario drafts in sessionStorage (browser-safe, storage injected for tests).
// Browser Back/Forward inside the app can't be blocked reliably, so instead of blocking we keep
// the draft and offer it again when the editor mounts.
import type { Step } from "@defe2end/shared";

export interface ScenarioDraft {
  /** The scenario's `updatedAt` the edits were based on; the save sends it, so a newer server version still answers 409. */
  baseUpdatedAt: string;
  name: string;
  description: string;
  siteId: string;
  steps: Step[];
  /** Whole-run retry setting (spec 4.3); missing in drafts kept before it existed. */
  retryOnFailure?: boolean;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// v3: the step format changed (docs/action-spec.md); older drafts are ignored.
const PREFIX = "defe2end:scenario-draft:v3";

/** Per user too: signing in as someone else in the same tab must never restore the previous account's edits. */
export function draftKey(workspaceSlug: string, scenarioId: string, userId: string): string {
  return `${PREFIX}:${userId}:${workspaceSlug}:${scenarioId}`;
}

/** sessionStorage when available (not on the server, not when the browser blocks it). */
export function browserStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** False when the draft couldn't be kept (no storage, quota, privacy mode); the link guard still works. */
export function saveDraft(store: Store | null, key: string, draft: ScenarioDraft): boolean {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** Calls `notify` on the first failed save only, so the editor warns once per session instead of on every keystroke. */
export function draftFailureNotice(notify: () => void): (saved: boolean) => void {
  let notified = false;
  return (saved) => {
    if (saved || notified) return;
    notified = true;
    notify();
  };
}

function isDraft(value: unknown): value is ScenarioDraft {
  const d = value as Partial<ScenarioDraft> | null;
  return (
    typeof d === "object" &&
    d !== null &&
    typeof d.baseUpdatedAt === "string" &&
    typeof d.name === "string" &&
    typeof d.description === "string" &&
    typeof d.siteId === "string" &&
    Array.isArray(d.steps)
  );
}

/** The stored draft, or null. A corrupt entry is removed. */
export function loadDraft(store: Store | null, key: string): ScenarioDraft | null {
  const raw = store?.getItem(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isDraft(parsed)) return parsed;
  } catch {
    // fall through
  }
  clearDraft(store, key);
  return null;
}

export function clearDraft(store: Store | null, key: string): void {
  store?.removeItem(key);
}

/** The server version moved on since the draft was made (someone saved in between). */
export function isStaleDraft(draft: ScenarioDraft, serverUpdatedAt: string): boolean {
  return draft.baseUpdatedAt !== serverUpdatedAt;
}
