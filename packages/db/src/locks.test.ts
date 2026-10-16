import { describe, expect, it } from "vitest";
import * as locks from "./locks.js";

describe("advisory lock ids", () => {
  // Two features picking the same id silently block each other (the notifier and the scheduler once did).
  it("are all different", () => {
    const ids = Object.values(locks).filter((v) => typeof v === "number");
    expect(new Set(ids).size).toBe(ids.length);
  });
});
