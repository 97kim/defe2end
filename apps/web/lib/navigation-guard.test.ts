import { afterEach, describe, expect, it, vi } from "vitest";
import { guardNavigation, hasUnsavedChanges, isPlainClick, registerLeaveGuard, setLeavePrompt, type LeaveGuard } from "./navigation-guard";
import type { LeaveChoice } from "./scenario-helpers";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function setup(dirty: boolean, choice: LeaveChoice, saved = true) {
  const editor: LeaveGuard = { isDirty: () => dirty, save: vi.fn(async () => saved), discard: vi.fn() };
  const host = { ask: vi.fn(async () => choice), settle: vi.fn() };
  cleanups.push(registerLeaveGuard(editor), setLeavePrompt(host));
  return { editor, host, go: vi.fn() };
}

describe("guardNavigation", () => {
  it("navigates straight away with no editor or a clean one", async () => {
    const go = vi.fn();
    expect(await guardNavigation(go)).toBe(true);
    const { host, go: go2 } = setup(false, "cancel");
    expect(await guardNavigation(go2)).toBe(true);
    expect(host.ask).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledOnce();
  });

  it("Cancel stays; the dialog is settled", async () => {
    const { host, editor, go } = setup(true, "cancel");
    expect(await guardNavigation(go)).toBe(false);
    expect(go).not.toHaveBeenCalled();
    expect(editor.discard).not.toHaveBeenCalled();
    expect(host.settle).toHaveBeenCalledOnce();
  });

  it("Discard drops the edits, then navigates", async () => {
    const { editor, go } = setup(true, "discard");
    expect(await guardNavigation(go)).toBe(true);
    expect(editor.discard).toHaveBeenCalledOnce();
    expect(editor.save).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledOnce();
  });

  it("Save and continue navigates only after a successful save", async () => {
    const ok = setup(true, "save", true);
    expect(await guardNavigation(ok.go)).toBe(true);
    expect(ok.editor.save).toHaveBeenCalledOnce();
    expect(ok.host.settle).toHaveBeenCalledOnce();
    cleanups.splice(0).forEach((f) => f());
    const failed = setup(true, "save", false);
    expect(await guardNavigation(failed.go)).toBe(false);
    expect(failed.go).not.toHaveBeenCalled();
  });

  it("unregistering only removes the same editor", () => {
    const first = registerLeaveGuard({ isDirty: () => false, save: async () => true, discard: () => {} });
    const second = registerLeaveGuard({ isDirty: () => true, save: async () => true, discard: () => {} });
    first(); // stale cleanup from an unmounted editor
    expect(hasUnsavedChanges()).toBe(true);
    second();
    expect(hasUnsavedChanges()).toBe(false);
  });
});

it("isPlainClick ignores modified and non-primary clicks", () => {
  const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  expect(isPlainClick(base)).toBe(true);
  expect(isPlainClick({ ...base, metaKey: true })).toBe(false);
  expect(isPlainClick({ ...base, button: 1 })).toBe(false);
});
