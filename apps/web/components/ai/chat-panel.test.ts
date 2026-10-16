import { describe, expect, it, vi } from "vitest";
import { scrollToEnd } from "./chat-panel";

describe("chat panel scroll effect", () => {
  it("returns no cleanup even when scrollIntoView returns a Promise (Electron 44)", () => {
    const scrollIntoView = vi.fn(() => Promise.resolve()) as unknown as Element["scrollIntoView"];
    expect(scrollToEnd({ scrollIntoView })).toBeUndefined();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    expect(scrollToEnd(null)).toBeUndefined();
  });
});
