import { describe, expect, it } from "vitest";
import { maskSecrets, SECRET_MASK } from "./index.js";

describe("maskSecrets", () => {
  it("hides every occurrence", () => {
    expect(maskSecrets("pw=hunter2 again hunter2", ["hunter2"])).toBe(`pw=${SECRET_MASK} again ${SECRET_MASK}`);
  });

  it("hides the longer of overlapping secrets completely", () => {
    expect(maskSecrets("token abc123xyz", ["abc", "abc123xyz"])).toBe(`token ${SECRET_MASK}`);
  });

  it("treats secrets literally and ignores empty ones", () => {
    expect(maskSecrets("a.b a+b", ["a.b", ""])).toBe(`${SECRET_MASK} a+b`);
    expect(maskSecrets("nothing here", [])).toBe("nothing here");
  });
});
