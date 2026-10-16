import { describe, expect, it } from "vitest";
import { aiBridge } from "./bridge";

describe("aiBridge", () => {
  const fn = () => undefined;
  it("is null in a plain browser or with a partial preload", () => {
    expect(aiBridge(undefined)).toBeNull();
    expect(aiBridge({})).toBeNull();
    expect(aiBridge({ defe2end: { ai: { status: fn, send: fn } } })).toBeNull();
  });
  it("returns the preload's ai bundle when complete", () => {
    const ai = { status: fn, send: fn, stop: fn, onEvent: fn };
    expect(aiBridge({ defe2end: { ai } })).toBe(ai);
  });
});
