import { describe, expect, it } from "vitest";
import { attachmentToken, parseJsonLdCondition, parseUploadToken, parseUrlPattern, uploadAttachmentRefs, scenarioExportSchema, STEP_ACTIONS, stepsSchema, stepTimeout, urlPatternMatches, wildcardMatch } from "./index.js";

const ok = (steps: unknown[]) => stepsSchema.safeParse(steps).success;

describe("stepsSchema", () => {
  it("has the 34 spec actions", () => {
    expect(STEP_ACTIONS).toHaveLength(34);
  });

  it("accepts every action with what it needs", () => {
    const steps = [
      { id: "1", action: "goto", url: "/products", name: "Open" },
      { id: "2", action: "click", selector: "button(Add to cart)", timeout: 5000, optional: true },
      { id: "3", action: "click", position: { x: 10, y: 20 } },
      { id: "4", action: "fill", selector: "input", value: "" },
      { id: "5", action: "fill", selector: "input" },
      { id: "6", action: "select", selector: "select", value: "b" },
      { id: "7", action: "pressKey", value: "Enter" },
      { id: "8", action: "hover", selector: "a" },
      { id: "9", action: "scroll", value: "bottom" },
      { id: "10", action: "scroll" },
      { id: "11", action: "wait", timeout: 200 },
      { id: "12", action: "uploadFile", selector: "input[type=file]", value: "https://x.test/a.png, https://x.test/b.pdf" },
      { id: "13", action: "clickFirstEnabled", selector: "button", expected: "background-color:#000000" },
      { id: "14", action: "waitForSelector", selector: "h1" },
      { id: "15", action: "waitForUrl", expected: "/cart{,/}" },
      { id: "16", action: "assertVisible", selector: "h1" },
      { id: "17", action: "assertVisibleOrWarn", selector: ".banner" },
      { id: "18", action: "assertText", selector: "h1", expected: "Hi" },
      { id: "19", action: "assertUrl", expected: "/cart*" },
      { id: "20", action: "assertTitle", expected: "Shop*" },
      { id: "21", action: "assertCount", selector: "li", expected: "0" },
      { id: "22", action: "assertExists", selector: "meta[name=description]" },
      { id: "23", action: "assertJsonLd", expected: "offers[*].price=10" },
      { id: "24", action: "assertResponse", expected: "/api/cart", value: "201" },
      { id: "25", action: "screenshot", threshold: 3, mask: ".ad" },
      { id: "26", action: "clickAndWaitPopup", selector: "a" },
      { id: "27", action: "clickInPopup", selector: "a" },
      { id: "28", action: "fillInPopup", selector: "input", value: "x" },
      { id: "29", action: "assertVisibleInPopup", selector: "h1" },
      { id: "30", action: "assertPopupUrl", expected: "/popup" },
      { id: "31", action: "closePopup" },
      { id: "32", action: "clickInIframe", selector: "iframe#a >>> iframe#b", value: "button" },
      { id: "33", action: "fillInIframe", selector: "iframe", value: "input", expected: "" },
      { id: "34", action: "assertVisibleInIframe", selector: "iframe", value: "p" },
      { id: "35", action: "clickAndAcceptDialog", selector: "button", expected: "Sure?" },
      { id: "36", action: "clickAndDismissDialog", selector: "button" },
      { id: "37", action: "clickAndSubmitPrompt", selector: "button", value: "Kim" },
    ];
    const parsed = stepsSchema.safeParse(steps);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it("rejects unknown actions, unknown keys and duplicate ids", () => {
    expect(ok([{ id: "1", action: "navigate", url: "/" }])).toBe(false);
    expect(ok([{ id: "1", action: "switchPage" }])).toBe(false);
    expect(ok([{ id: "1", action: "click", target: "a" }])).toBe(false);
    expect(ok([{ id: "1", action: "hover", selector: "a", url: "/" }])).toBe(true);
    expect(ok([{ id: "1", action: "goto", url: "/", options: {} }])).toBe(false);
    expect(ok([{ id: "1", action: "closePopup" }, { id: "1", action: "closePopup" }])).toBe(false);
  });

  it("rejects steps their action can't run", () => {
    expect(ok([{ id: "1", action: "goto" }])).toBe(false);
    expect(ok([{ id: "1", action: "click" }])).toBe(false);
    expect(ok([{ id: "1", action: "hover" }])).toBe(false);
    expect(ok([{ id: "1", action: "select", selector: "s" }])).toBe(false);
    expect(ok([{ id: "1", action: "pressKey" }])).toBe(false);
    expect(ok([{ id: "1", action: "uploadFile", selector: "input", value: "avatar.png" }])).toBe(false);
    expect(ok([{ id: "1", action: "waitForUrl", expected: "/a{b" }])).toBe(false);
    expect(ok([{ id: "1", action: "waitForUrl", expected: "/a{b{c}}" }])).toBe(false);
    expect(ok([{ id: "1", action: "assertText", selector: "h1", expected: "" }])).toBe(false);
    expect(ok([{ id: "1", action: "assertCount", selector: "li", expected: "-1" }])).toBe(false);
    expect(ok([{ id: "1", action: "assertJsonLd", expected: "[0].a" }])).toBe(false);
    expect(ok([{ id: "1", action: "assertResponse", expected: "/api", value: "700" }])).toBe(false);
    expect(ok([{ id: "1", action: "clickInIframe", selector: "#frame", value: "a" }])).toBe(false);
    expect(ok([{ id: "1", action: "fillInIframe", selector: "iframe", value: "a" }])).toBe(false);
    expect(ok([{ id: "1", action: "clickAndSubmitPrompt", selector: "b", value: "" }])).toBe(false);
    expect(ok([{ id: "1", action: "screenshot", threshold: 101 }])).toBe(false);
    expect(ok([{ id: "1", action: "wait", timeout: 600_001 }])).toBe(false);
  });

  it("skips format checks for values with {{variables}}", () => {
    expect(ok([{ id: "1", action: "uploadFile", selector: "input", value: "{{FILE}}" }])).toBe(true);
    expect(ok([{ id: "1", action: "assertCount", selector: "li", expected: "{{N}}" }])).toBe(true);
    expect(ok([{ id: "1", action: "assertText", selector: "h1", expected: "{{EMPTY}}" }])).toBe(true);
  });

  it("accepts attachment:<name> tokens next to URLs and rejects bad or templated ones", () => {
    const upload = (value: string) => ok([{ id: "1", action: "uploadFile", selector: "input", value }]);
    expect(upload("attachment:avatar.png")).toBe(true);
    expect(upload("attachment:avatar.png, https://x.test/b.pdf attachment:my%20file.pdf")).toBe(true);
    expect(upload("attachment:사진.png {{URL}}")).toBe(true);
    expect(upload("attachment:")).toBe(false);
    expect(upload("attachment:a%2Fb.png")).toBe(false);
    expect(upload("attachment:%E0%A4%A")).toBe(false);
    expect(upload(`attachment:${"a".repeat(201)}`)).toBe(false);
    expect(upload("attachment:{{FILE}}")).toBe(false);
    expect(upload("attachment:x.png avatar.png")).toBe(false);
  });

  it("encodes attachment tokens so they survive separators and lists referenced names once", () => {
    expect(attachmentToken("my file, 100%.png")).toBe("attachment:my%20file%2C%20100%25.png");
    expect(parseUploadToken(attachmentToken("my file, 100%.png"))).toEqual({ kind: "attachment", name: "my file, 100%.png" });
    expect(parseUploadToken("https://x.test/a.png")).toEqual({ kind: "url", url: "https://x.test/a.png" });
    expect(
      uploadAttachmentRefs([
        { action: "fill", value: "attachment:no" },
        { action: "uploadFile", value: "attachment:a.png https://x.test/b" },
        { action: "uploadFile", value: "attachment:a.png,attachment:c.png" },
      ]),
    ).toEqual([
      { name: "a.png", stepIndex: 1 },
      { name: "c.png", stepIndex: 2 },
    ]);
  });

  it("uses 30000 ms by default and 1000 ms for wait", () => {
    expect(stepTimeout({ action: "click" })).toBe(30_000);
    expect(stepTimeout({ action: "wait" })).toBe(1000);
    expect(stepTimeout({ action: "wait", timeout: 50 })).toBe(50);
  });
});

describe("matching helpers", () => {
  it("wildcard: substring without *, unanchored pattern with *", () => {
    expect(wildcardMatch("https://a.test/cart?x=1", "/cart")).toBe(true);
    expect(wildcardMatch("https://a.test/cart?x=1", "a.test/*?x=")).toBe(true);
    expect(wildcardMatch("https://a.test/Cart", "/cart")).toBe(false);
    expect(wildcardMatch("abc", "a.c*")).toBe(false);
  });

  it("waitForUrl pattern: brace alternatives, escapes, literal specials", () => {
    const p = parseUrlPattern("/item.{a,b}\\{x\\}?");
    expect(p).toEqual({ ok: true, kind: "alternatives", options: ["/item.a{x}?", "/item.b{x}?"] });
    expect(urlPatternMatches("https://t/item.b{x}?q", p)).toBe(true);
    expect(urlPatternMatches("https://t/itemXb{x}?q", p)).toBe(false);
    expect(parseUrlPattern("a}b").ok).toBe(false);
  });

  it("json-ld conditions", () => {
    expect(parseJsonLdCondition(" @type=Product ")).toMatchObject({ ok: true, op: "equals", value: "Product", path: [{ name: "@type", indexes: [] }] });
    // Only the whole expression is trimmed; spaces around the operator stay in the key and value.
    expect(parseJsonLdCondition("@type = Product")).toMatchObject({ ok: true, op: "equals", value: " Product", path: [{ name: "@type ", indexes: [] }] });
    expect(parseJsonLdCondition("offers[0].name*=Red")).toMatchObject({ ok: true, op: "contains", path: [{ name: "offers", indexes: [0] }, { name: "name" }] });
    expect(parseJsonLdCondition("image")).toMatchObject({ ok: true, op: "exists" });
    for (const bad of ["", "a..b", "[0]", "a[x]", "=x", "a="]) expect(parseJsonLdCondition(bad).ok).toBe(false);
  });
});

describe("scenarioExportSchema", () => {
  const file = {
    format: "defe2end.scenario",
    formatVersion: 1,
    stepFormatVersion: 1,
    scenarios: [{ name: "Checkout", site: "Shop", steps: [{ id: "1", action: "goto", url: "/" }] }],
  };

  it("accepts a valid file and fills defaults", () => {
    expect(scenarioExportSchema.parse(file).scenarios[0]).toMatchObject({ description: "", tags: [] });
  });

  it("rejects other formats and versions", () => {
    expect(scenarioExportSchema.safeParse({ ...file, format: "other" }).success).toBe(false);
    expect(scenarioExportSchema.safeParse({ ...file, stepFormatVersion: 2 }).success).toBe(false);
  });
});

describe("keys the action doesn't use (spec section 1)", () => {
  const parse = (step: object) => stepsSchema.safeParse([{ id: "s1", ...step }]);

  it("are kept on save, unchecked, while unknown keys are still rejected", () => {
    const step = { action: "hover", selector: "#b", value: "hello", url: "not a url", threshold: 500, position: { x: 1.5, y: 2 }, expected: "@@" };
    const parsed = parse(step);
    expect(parsed.success && parsed.data[0]).toEqual({ id: "s1", ...step });
    expect(parse({ action: "goto", url: "/", value: "x", mask: ".m" }).success).toBe(true);
    expect(parse({ action: "goto", url: "/", target: "x" }).success).toBe(false);
  });

  it("are still checked when the action uses them", () => {
    expect(parse({ action: "screenshot", threshold: 500 }).success).toBe(false);
    expect(parse({ action: "click", position: { x: 1.5, y: 2 } }).success).toBe(false);
    expect(parse({ action: "assertCount", selector: "li", expected: "two" }).success).toBe(false);
    expect(parse({ action: "assertCount", selector: "li", expected: "two", value: "anything" }).success).toBe(false);
  });
});
