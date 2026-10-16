// Stage 7 contract section 5: page masking, solid boxes in screenshots, refusal to capture unmasked, the
// scenario switch and no trace while masking is on.
import { DEFAULT_DEVICE, type Step } from "@defe2end/shared";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { MASK_ATTR, pageMaskScript } from "./masking.js";
import { execute, makePlan, pixelAt, SANDBOX, useFixtures } from "./test-support.js";

const fixtures = useFixtures();
const MAGENTA = [255, 0, 255];
const SETTINGS = { enabled: true, selectors: [".private"], policyVersion: 1 };
const open: Step = { id: "open", action: "goto", url: "/mask.html" };
const later: Step = { id: "later", action: "wait", value: "700" };
const fillEmail: Step = { id: "fill", action: "fill", selector: "#typed", value: "lee@example.org" };
const shot: Step = { id: "s", action: "screenshot", name: "masked", mask: "#step" };
/** Centre of each fixture box (absolute layout of mask.html; the iframe's card sits at its top left). */
const at = (top: number) => [170, top + 15] as const;
const BOXES = { email: at(20), site: at(60), late: at(100), shadow: at(140), card: at(180), plain: at(260), password: at(300), step: at(340), typed: at(380) };

async function colors(png: Buffer) {
  const out: Record<string, number[]> = {};
  for (const [name, [x, y]] of Object.entries(BOXES)) out[name] = await pixelAt(png, x, y);
  return out;
}

describe("masking in screenshots", () => {
  it("covers site selectors, detected personal data, late, shadow, iframe, field and step areas", async () => {
    const { files, results } = await execute(makePlan(fixtures.url, [open, later, fillEmail, shot]), { masking: SETTINGS });
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "passed"]);
    const c = await colors(files.find((f) => f.name === "masked")!.bytes);
    for (const name of ["email", "site", "late", "shadow", "card", "password", "step", "typed"]) expect(c[name], name).toEqual(MAGENTA);
    // Eight digits or fewer are never personal data on their own.
    expect(c.plain).not.toEqual(MAGENTA);
  });

  it("covers a popup's page too", async () => {
    const { files, results } = await execute(
      makePlan(fixtures.url, [open, { id: "p", action: "clickAndWaitPopup", selector: "#open-popup" }, later, { id: "s", action: "screenshot", name: "popup" }]),
      { masking: SETTINGS },
    );
    expect(results.every((r) => r.status === "passed")).toBe(true);
    const c = await colors(files.find((f) => f.name === "popup")!.bytes);
    for (const name of ["email", "site", "late", "shadow", "card"]) expect(c[name], name).toEqual(MAGENTA);
  });

  it("with the scenario switch off keeps field and step masks only", async () => {
    const { files } = await execute(makePlan(fixtures.url, [open, later, fillEmail, shot]), { masking: { ...SETTINGS, enabled: false } });
    const c = await colors(files.find((f) => f.name === "masked")!.bytes);
    for (const name of ["email", "site", "late", "shadow", "card", "typed"]) expect(c[name], name).not.toEqual(MAGENTA);
    expect(c.password).toEqual(MAGENTA);
    expect(c.step).toEqual(MAGENTA);
  });

  it("refuses to capture when masking can't be applied; the step fails and nothing is stored", async () => {
    const { files, results, logs } = await execute(makePlan(fixtures.url, [open, { ...shot, mask: "#step, div[" }]), { masking: SETTINGS });
    expect(results[1]!.status).toBe("failed");
    expect(results[1]!.errorMessage).toBe("Masking could not be applied, so the screenshot was not taken");
    // No failure screenshot either: it would lack the step's mask.
    expect(files.filter((f) => f.kind === "screenshot")).toEqual([]);
    expect(logs.some((l) => l.startsWith('Screenshot "masked" not collected: masking could not be applied'))).toBe(true);
  });

  it("skips the failure screenshot when masking can't be applied", async () => {
    const { files, results } = await execute(
      makePlan(fixtures.url, [open, { id: "bad", action: "assertText", selector: "#email", expected: "nope", timeout: 300 }]),
      { masking: { ...SETTINGS, selectors: ["div["] } },
    );
    expect(results[1]!.status).toBe("failed");
    expect(files.filter((f) => f.kind === "screenshot")).toEqual([]);
  });

  it("records no trace while masking is on, and one when it is off", async () => {
    const failing: Step = { id: "bad", action: "assertText", selector: "#email", expected: "nope", timeout: 300 };
    const plan = makePlan(fixtures.url, [open, failing], { capture: { video: false, traceOnFailure: true } });
    const on = await execute(plan, { masking: SETTINGS });
    expect(on.files.filter((f) => f.kind === "trace")).toEqual([]);
    const off = await execute({ ...plan, runId: `${plan.runId}-off` }, { masking: { ...SETTINGS, enabled: false } });
    expect(off.files.filter((f) => f.kind === "trace")).toHaveLength(1);
  });
});

describe("page masking script", () => {
  async function withPage<T>(selectors: string[], fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
    const browser = await chromium.launch({ chromiumSandbox: SANDBOX });
    try {
      const context = await browser.newContext({ viewport: DEFAULT_DEVICE.viewport });
      await context.addInitScript(pageMaskScript({ enabled: true, selectors, policyVersion: 1 }));
      return await fn(await context.newPage());
    } finally {
      await browser.close();
    }
  }

  it("blurs selector matches on the same DOM change and dots input text without changing values", async () => {
    await withPage([".private"], async (page) => {
      await page.goto(`${fixtures.url}/mask-busy.html`);
      const same = await page.evaluate(async (attr) => {
        const el = document.createElement("div");
        el.className = "private";
        el.textContent = "x";
        document.body.append(el);
        await Promise.resolve();
        await Promise.resolve();
        return el.getAttribute(attr);
      }, MASK_ATTR);
      expect(same).toBe("site");
      expect(await page.locator(".private").evaluate((el) => getComputedStyle(el).filter)).toBe("blur(10px)");
      await page.evaluate(() => {
        const input = document.createElement("input");
        input.id = "in";
        document.body.append(input);
      });
      await page.fill("#in", "park@example.com");
      await page.waitForFunction((attr) => document.getElementById("in")!.hasAttribute(attr), MASK_ATTR, { timeout: 1_000 });
      expect(await page.inputValue("#in")).toBe("park@example.com");
      expect(await page.locator("#in").evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-text-security"))).toBe("disc");
    });
  });

  it("hides emails with digits but not short digit runs", async () => {
    await withPage([], async (page) => {
      await page.goto(`${fixtures.url}/mask-busy.html`);
      const marks = await page.evaluate(async (attr) => {
        const make = (text: string) => {
          const el = document.createElement("div");
          el.textContent = text;
          document.body.append(el);
          return el;
        };
        const els = [make("user1@example.com"), make("12345678@ex.co"), make("Order 12345678"), make("02-123-45")];
        await new Promise((r) => setTimeout(r, 500));
        return els.map((el) => el.hasAttribute(attr));
      }, MASK_ATTR);
      expect(marks).toEqual([true, true, false, false]);
    });
  });

  it("detects personal data within 300 ms on a page that keeps changing", async () => {
    await withPage([], async (page) => {
      await page.goto(`${fixtures.url}/mask-busy.html`);
      const elapsed = await page.evaluate(async (attr) => {
        const el = document.createElement("div");
        el.textContent = "choi@example.net";
        const start = performance.now();
        document.body.append(el);
        while (!el.hasAttribute(attr)) {
          if (performance.now() - start > 2_000) return -1;
          await new Promise((r) => setTimeout(r, 5));
        }
        return performance.now() - start;
      }, MASK_ATTR);
      expect(elapsed).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(400);
    });
  });
});
