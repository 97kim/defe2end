// App-wide unsaved-changes guard (browser-safe, module-level registry).
// An editor registers its dirty state and save/discard; anything that leaves or replaces it
// (shell links, workspace switcher, in-page actions) calls `guardNavigation()` first.
// Full page loads (reload, closing the tab, typed URLs) are the editor's `beforeunload` job.
import { confirmLeave, type LeaveChoice } from "./scenario-helpers";

export interface LeaveGuard {
  isDirty(): boolean;
  /** True when saved; false keeps the user where they are. */
  save(): Promise<boolean>;
  /** Drop the unsaved edits (e.g. remount the editor from the saved version). */
  discard(): void;
}

export interface LeavePrompt {
  ask(): Promise<LeaveChoice>;
  /** Called once the decision (including a "Save and continue" save) is finished. */
  settle(): void;
}

let guard: LeaveGuard | null = null;
let prompt: LeavePrompt | null = null;

/** Called by an editor while it is mounted. Returns the unregister function. */
export function registerLeaveGuard(next: LeaveGuard): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

/** Called by the dialog host (mounted once in the workspace layout). */
export function setLeavePrompt(next: LeavePrompt): () => void {
  prompt = next;
  return () => {
    if (prompt === next) prompt = null;
  };
}

/** Plain-click check for links: modified clicks open a new tab and leave the editor alone. */
export function isPlainClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function hasUnsavedChanges(): boolean {
  return guard?.isDirty() ?? false;
}

/**
 * Runs `go` unless the user cancels: clean → go; dirty → ask Save and continue / Discard / Cancel.
 * Returns whether `go` ran.
 */
export async function guardNavigation(go: () => void | Promise<void>): Promise<boolean> {
  const current = guard;
  const host = prompt;
  const outcome = await confirmLeave(
    current?.isDirty() ?? false,
    // Without a mounted host, fall back to the browser's confirm (OK = discard).
    () => (host ? host.ask() : Promise.resolve(globalThis.confirm?.("Discard unsaved changes?") ? "discard" : "cancel")),
    () => current?.save() ?? Promise.resolve(false),
  ).finally(() => host?.settle());
  if (!outcome) return false;
  if (outcome === "discarded") current?.discard();
  await go();
  return true;
}
