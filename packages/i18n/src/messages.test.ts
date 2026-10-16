import { describe, expect, it } from "vitest";
import { LOCALES, messages } from "./index.js";

function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe("messages", () => {
  it("every locale has the same keys as English", () => {
    const expected = keyPaths(messages.en).sort();
    for (const locale of LOCALES) {
      expect(keyPaths(messages[locale]).sort(), locale).toEqual(expected);
    }
  });

  it("has no empty strings", () => {
    for (const locale of LOCALES) {
      for (const path of keyPaths(messages[locale])) {
        const text = path.split(".").reduce<any>((node, key) => node[key], messages[locale]);
        expect(text, `${locale}:${path}`).not.toBe("");
      }
    }
  });
});
