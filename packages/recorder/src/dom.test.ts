import { startFixtureServer, type FixtureServer } from "@defe2end/test-fixtures";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recorderDom } from "./dom.js";
import { elementInfoSchema, type ElementInfo } from "./index.js";

const SANDBOX = process.env.CHROMIUM_SANDBOX !== "false";
let server: FixtureServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch({ chromiumSandbox: SANDBOX });
  page = await browser.newPage();
  await page.goto(`${server.url}/recorder.html`);
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** Runs `recorderDom` in the page the way the preload does: the function source, no imports. */
async function describeEl(selector: string, testAttributes: string[] = [], climb = false): Promise<ElementInfo> {
  const info = await page.evaluate(
    ([src, sel, attrs, up]) => {
      const dom = (0, eval)(`(${src})`)();
      const el = document.querySelector(sel)!;
      return dom.describe(up ? dom.actionable(el) : el, attrs);
    },
    [recorderDom.toString(), selector, testAttributes, climb] as const,
  );
  return elementInfoSchema.parse(info);
}
async function raw(selector: string, testAttributes: string[] = []): Promise<string[]> {
  return page.evaluate(([src, sel, attrs]) => (0, eval)(`(${src})`)().candidates(document.querySelector(sel)!, attrs), [recorderDom.toString(), selector, testAttributes] as const);
}

describe("selector candidates", () => {
  it("builds them in spec order with the test attribute list", async () => {
    expect(await raw("#buy", ["data-missing", "data-track"])).toEqual([
      "button(Buy now)",
      "#buy",
      '[data-testid="buy-button"]',
      'button[data-track="buy"]',
      "button.btn-primary",
      "button.btn-primary.btn",
      "text=Buy now",
    ]);
    expect(await raw("#buy")).not.toContain('button[data-track="buy"]');
  });

  it("skips dynamic ids, role names with ')' and unstable classes", async () => {
    expect(await raw("#order-123456")).toEqual(["button(Order)", "button.btn", "text=Order"]);
    expect(await raw('[aria-label="Close (x)"]')).toEqual(["text=Close (x)"]);
    expect(await raw("#deep")).toEqual(["#deep", "text=Deep text"]);
    expect(await raw("div.menu-item")).toEqual(["div.menu-item", "text=Deep text"]);
  });

  it("puts the path before the full href and drops tracking, root and javascript links", async () => {
    expect(await raw("#a1")).toEqual(["link(Products)", "#a1", 'a[href*="/products.html"]', 'a[href*="/products.html?ref=nav#top"]', "text=Products"]);
    expect(await raw('a[href="/"]')).toEqual(["link(Home)", "text=Home"]);
    expect(await raw('a[href*="googleadservices"]')).toEqual(["link(Ad)", "text=Ad"]);
    expect(await raw('a[href*="gclid"]')).toEqual(["link(Deal)", "text=Deal"]);
    expect(await raw('a[href^="javascript"]')).toEqual(["link(More)", "a.more-link", "text=More"]);
  });

  it("names card links by their title and keeps long text only as a last resort", async () => {
    expect((await raw("a.card"))[0]).toBe("link(Card title)");
    expect(await raw("a.card")).not.toContainEqual(expect.stringMatching(/^text=/));
    expect(await raw("body > p")).toEqual(["p.long-paragraph-class"]);
    await page.evaluate(() => document.querySelector("body > p")!.classList.remove("long-paragraph-class"));
    expect(await raw("body > p")).toEqual(["text=This paragraph is definitely longer than"]);
  });

  it("uses name and placeholder", async () => {
    expect(await raw('input[name="email"]')).toEqual(['input[name="email"]', 'input[placeholder="you@example.com"]']);
  });

  it("never keeps a typed password in a candidate", async () => {
    await page.fill("#pw", "pw");
    expect(await raw("#pw")).toEqual([]);
    await page.fill("#pw", "");
    expect(await raw("#pw")).toEqual(["#pw", 'input[name="pw"]']);
  });
});

describe("ranking and description", () => {
  it("moves selectors matching several elements behind unique ones", async () => {
    const info = await describeEl("button.dup");
    expect(info.selectors).toEqual(["text=Same", "button(Same)", "button.dup"]);
  });

  it("keeps the build order within a grade", async () => {
    expect((await describeEl("#buy")).selectors[0]).toBe("button(Buy now)");
  });

  it("climbs to the actionable ancestor", async () => {
    expect((await describeEl("#inner", [], true)).selectors).toEqual(["div.plain", "text=Inner click"]);
    expect((await describeEl("label input", [], true)).tagName).toBe("input");
  });

  it("describes type, role, text and placeholder, never a password's text", async () => {
    expect(await describeEl("#buy")).toMatchObject({ tagName: "button", role: "button", text: "Buy now" });
    expect(await describeEl('input[name="email"]')).toMatchObject({ tagName: "input", type: "email", placeholder: "you@example.com" });
    expect((await describeEl("#pw")).text).toBeUndefined();
  });

  it("flags fixed overlays with z-index 1000 or more", async () => {
    expect((await describeEl(".close-banner")).inOverlay).toBe(true);
    expect((await describeEl(".low-btn")).inOverlay).toBeUndefined();
  });
});
