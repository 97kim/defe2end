import { describe, expect, it } from "vitest";
import { isCiPass, RUN_TERMINAL_STATUSES } from "./index.js";

describe("isCiPass", () => {
  it("passes only on passed", () => {
    expect(RUN_TERMINAL_STATUSES.filter((s) => isCiPass(s))).toEqual(["passed"]);
  });
});
