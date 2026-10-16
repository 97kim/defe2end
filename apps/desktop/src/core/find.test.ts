import { describe, expect, it } from "vitest";
import { isFindShortcut, matchLabel, parseFindQuery } from "./find.js";

const key = (over: Partial<Parameters<typeof isFindShortcut>[0]> = {}) => ({ type: "keyDown", key: "f", meta: false, control: false, alt: false, shift: false, ...over });

describe("find bar rules", () => {
  it("opens on ⌘F on macOS and Ctrl+F elsewhere, key down only", () => {
    expect(isFindShortcut(key({ meta: true }), "darwin")).toBe(true);
    expect(isFindShortcut(key({ control: true }), "darwin")).toBe(false);
    expect(isFindShortcut(key({ control: true, key: "F" }), "win32")).toBe(true);
    expect(isFindShortcut(key({ meta: true }), "win32")).toBe(false);
    expect(isFindShortcut(key({ meta: true, type: "keyUp" }), "darwin")).toBe(false);
    expect(isFindShortcut(key({ meta: true, alt: true }), "darwin")).toBe(false);
    expect(isFindShortcut(key({ meta: true, key: "g" }), "darwin")).toBe(false);
  });

  it("accepts only well-formed queries", () => {
    expect(parseFindQuery({ text: "cart", forward: false, findNext: true })).toEqual({ text: "cart", forward: false, findNext: true });
    expect(parseFindQuery({ text: "cart", forward: "yes", findNext: true })).toBeNull();
    expect(parseFindQuery({ text: "x".repeat(501), forward: true, findNext: false })).toBeNull();
    expect(parseFindQuery("cart")).toBeNull();
  });

  it("shows n/m or the no-match label", () => {
    expect(matchLabel({ activeMatchOrdinal: 2, matches: 5 }, "No results")).toBe("2/5");
    expect(matchLabel({ activeMatchOrdinal: 0, matches: 0 }, "No results")).toBe("No results");
    expect(matchLabel(null, "No results")).toBe("");
  });
});
