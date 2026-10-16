import { describe, expect, it } from "vitest";
import { desktopRunMessageSchema, DESKTOP_CAPABILITIES } from "./desktop-protocol.js";
import { stepOutcomeSchema } from "./execution.js";
import { checkCssSelector, parseMaskSelectorList, renderConditionDiff, screenQualityCapabilities, splitSelectorList, type RenderConditions } from "./screen-quality.js";

describe("splitSelectorList", () => {
  it("splits on commas and line breaks, trims and drops blanks", () => {
    expect(splitSelectorList(" .a , #b\n\n.c\r\n,, ")).toEqual([".a", "#b", ".c"]);
    expect(splitSelectorList("")).toEqual([]);
  });

  it("keeps commas inside parentheses, brackets and quotes", () => {
    expect(splitSelectorList(`:is(.a, .b) span, [title="x, y"], [data-k='p,q'] , a[href*="(,"]`)).toEqual([
      ":is(.a, .b) span",
      `[title="x, y"]`,
      `[data-k='p,q']`,
      `a[href*="(,"]`,
    ]);
    expect(splitSelectorList(String.raw`.a\,b, .c`)).toEqual([String.raw`.a\,b`, ".c"]);
  });
});

describe("parseMaskSelectorList", () => {
  it("accepts standard CSS", () => {
    const text = ".price\n#card-number, input[name='ssn'], div:has(> img.avatar), li:nth-child(2n+1) span, :is(.a, .b), *";
    expect(parseMaskSelectorList(text)).toEqual({ ok: true, selectors: [".price", "#card-number", "input[name='ssn']", "div:has(> img.avatar)", "li:nth-child(2n+1) span", ":is(.a, .b)", "*"] });
  });

  it("names the first invalid item, 1-based", () => {
    const result = parseMaskSelectorList(".ok\n.also-ok, div[");
    expect(result).toMatchObject({ ok: false, index: 2, position: 3, selector: "div[" });
  });

  it("refuses engine-specific locators, unknown pseudo-classes, pseudo-elements and namespaces", () => {
    for (const bad of ["text=Total", "role=button", "div >> span", ":foo", "p::before", "svg|a", "#1a", "& .a"]) {
      expect(checkCssSelector(bad), bad).not.toBeNull();
    }
  });

  it("refuses an overlong selector and too many items", () => {
    expect(checkCssSelector(`.${"a".repeat(600)}`)).toMatch(/longer/);
    expect(parseMaskSelectorList(Array.from({ length: 201 }, (_, i) => `.c${i}`).join(","))).toMatchObject({ ok: false, position: 201 });
  });
});

describe("render conditions", () => {
  const base: RenderConditions = { browserVersion: "140.0", deviceScaleFactor: 2, viewport: { width: 1280, height: 720 }, fontSet: "mac-15", maskingPolicyVersion: 1 };
  it("lists what differs", () => {
    expect(renderConditionDiff(base, { ...base })).toEqual([]);
    expect(renderConditionDiff(base, { ...base, browserVersion: "141.0", viewport: { width: 1280, height: 721 } })).toEqual(["browserVersion", "viewport"]);
  });
});

describe("screenQualityCapabilities", () => {
  const goto = { action: "goto" };
  const shot = { action: "screenshot" };
  it("needs masking for every run", () => {
    expect(screenQualityCapabilities({ steps: [goto], comparisonChild: false })).toEqual(["masking-v1"]);
  });
  it("needs visual compare when a screenshot is judged", () => {
    expect(screenQualityCapabilities({ steps: [goto, shot], comparisonChild: false })).toEqual(["masking-v1", "visual-compare-v1"]);
  });
  it("needs the accessibility snapshot, not visual compare, for a comparison child", () => {
    expect(screenQualityCapabilities({ steps: [goto, shot], comparisonChild: true })).toEqual(["masking-v1", "a11y-snapshot-v1"]);
  });
  it("this build announces all of them", () => {
    for (const f of ["masking-v1", "visual-compare-v1", "a11y-snapshot-v1"]) expect(DESKTOP_CAPABILITIES).toContain(f);
  });
});

describe("protocol fields", () => {
  const render: RenderConditions = { browserVersion: "1", deviceScaleFactor: 1, viewport: { width: 10, height: 10 }, fontSet: "f", maskingPolicyVersion: 1 };
  it("step results carry the visual verdict, raw values and the snapshot artifact", () => {
    const outcome = {
      index: 0, stepId: "s1", action: "screenshot", status: "passed", attempt: 1, attempts: 1, startedAt: new Date().toISOString(), durationMs: 1,
      visualVerdict: "shifted", visualDiffPercent: 5.0001, visualShiftDiffPercent: 0.2, visualShift: { x: -2, y: 1 }, visualBaselineVersionId: "v1", render, a11ySnapshotArtifactId: "a1",
    };
    expect(stepOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(stepOutcomeSchema.safeParse({ ...outcome, visualVerdict: "different" }).success).toBe(false);
    expect(stepOutcomeSchema.safeParse({ ...outcome, render: { ...render, extra: 1 } }).success).toBe(false);
    expect(stepOutcomeSchema.safeParse({ ...outcome, visualShift: { x: 0.5, y: 0 } }).success).toBe(false);
    expect(stepOutcomeSchema.safeParse({ ...outcome, visualSsim: 0.9 }).success).toBe(false);
  });

  it("run messages carry pinned baselines, masking and the comparison side; still strict", () => {
    const shape = desktopRunMessageSchema.shape;
    const baseline = { versionId: "v1", stepId: "s1", environmentId: "e1", device: "1280x720", runtime: "desktop-mac", width: 10, height: 10, render };
    expect(shape.baselines.parse([baseline])).toEqual([baseline]);
    expect(shape.baselines.safeParse([{ ...baseline, runtime: "desktop-linux" }]).success).toBe(false);
    expect(shape.masking.parse({ enabled: false, selectors: [".a"], policyVersion: 1 })).toBeTruthy();
    expect(shape.comparison.safeParse({ comparisonId: "c1", side: "middle" }).success).toBe(false);
    expect(shape.comparison.parse(undefined)).toBeUndefined();
  });
});
