import { startFixtureServer, type FixtureServer } from "@defe2end/test-fixtures";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DIALOG_WRAPPER_SOURCE, installCollector } from "./collect.js";
import { recorderDom } from "./dom.js";
import { rawEventSchema, type RawEvent } from "./index.js";

const SANDBOX = process.env.CHROMIUM_SANDBOX !== "false";
let server: FixtureServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch({ chromiumSandbox: SANDBOX });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** Installs the collector the way the preload does, with events kept on `window.__events`. */
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`${server.url}/recorder.html`);
  // The fixed overlays would sit over the controls the tests click.
  await page.addStyleTag({ content: "#low, #banner { display: none; }" });
  await page.evaluate(
    ([domSrc, collectSrc, dialogSrc]) => {
      const w = window as unknown as { __events: unknown[]; __collector: { setState(s: unknown): void; dialog(k: string, a: boolean, o?: number): void } };
      w.__events = [];
      const dom = (0, eval)(`(${domSrc})`)();
      (w as unknown as { __dialogSrc: string }).__dialogSrc = dialogSrc;
      w.__collector = (0, eval)(`(${collectSrc})`)({ dom, send: (e: unknown) => w.__events.push(e), testAttributes: [] });
      w.__collector.setState({ recording: true, tabId: "t1" });
      (0, eval)(dialogSrc);
      window.addEventListener("message", (event) => {
        const d = (event.data as { __defe2endDialog?: { kind: string; accepted: boolean; openMs?: number } })?.__defe2endDialog;
        if (d) w.__collector.dialog(d.kind, d.accepted, d.openMs);
      });
    },
    [recorderDom.toString(), installCollector.toString(), DIALOG_WRAPPER_SOURCE] as const,
  );
});

async function events(): Promise<RawEvent[]> {
  const list = await page.evaluate(() => (window as unknown as { __events: unknown[] }).__events);
  return list.map((e) => rawEventSchema.parse(e));
}

describe("collector", () => {
  it("records clicks on the actionable target with tab, frame and unique ids", async () => {
    await page.click("#inner");
    await page.click("#buy");
    const list = await events();
    expect(list.map((e) => e.type === "click" && e.target.selectors[0])).toEqual(["div.plain", "button(Buy now)"]);
    expect(list[0]).toMatchObject({ tabId: "t1", frame: { isSubframe: false, url: `${server.url}/recorder.html` }, pageUrl: `${server.url}/recorder.html` });
    expect(new Set(list.map((e) => e.id)).size).toBe(2);
  });

  it("skips clicks on selects and text inputs, and nothing is sent when not recording", async () => {
    await page.click('select[name="size"]');
    await page.click('input[name="email"]');
    await page.evaluate(() => (window as unknown as { __collector: { setState(s: unknown): void } }).__collector.setState({ recording: false, tabId: "t1" }));
    await page.click("#buy");
    expect(await events()).toEqual([]);
  });

  it("records fills on change and Enter once, masks passwords, and records select labels", async () => {
    await page.fill('input[name="email"]', "a@b.c");
    await page.press('input[name="email"]', "Enter");
    await page.click("#buy");
    await page.fill("#pw", "secret");
    await page.click("#buy");
    await page.selectOption('select[name="size"]', "Large");
    const list = await events();
    expect(list.map((e) => e.type)).toEqual(["input", "key", "click", "input", "click", "select"]);
    expect(list[0]).toMatchObject({ value: "a@b.c", isPassword: false });
    expect(list[1]).toMatchObject({ key: "Enter", composing: false });
    expect(list[3]).toMatchObject({ value: "{{PASSWORD}}", isPassword: true });
    expect(list[5]).toMatchObject({ label: "Large" });
    expect(JSON.stringify(list)).not.toContain("secret");
  });

  it("reports a scroll stop after 600 ms with edges", async () => {
    await page.evaluate(() => {
      document.body.style.height = "5000px";
      window.scrollTo(0, 5000);
    });
    await page.waitForTimeout(800);
    const [stop] = await events();
    expect(stop).toMatchObject({ type: "scroll", atBottom: true, atTop: false });
  });

  it("shows a check menu on right click and records the pick", async () => {
    await page.click("#buy", { button: "right" });
    await page.click("[data-defe2end-menu] >> text=Check text");
    const [check] = await events();
    expect(check).toMatchObject({ type: "contextmenu", check: "assertText", text: "Buy now", target: { selectors: ["button(Buy now)", "#buy", '[data-testid="buy-button"]', "button.btn-primary", "button.btn-primary.btn", "text=Buy now"] } });
    expect(await page.locator("[data-defe2end-menu]").count()).toBe(0);
  });

  it("reports dialogs from the page world", async () => {
    page.once("dialog", (d) => d.dismiss());
    await page.evaluate(() => window.confirm("Sure?"));
    page.once("dialog", (d) => d.accept());
    await page.evaluate(() => window.alert("Done"));
    await page.waitForTimeout(50);
    expect((await events()).map((e) => e.type === "dialog" && [e.kind, e.accepted])).toEqual([
      ["confirm", false],
      ["alert", true],
    ]);
  });

  it("reports how long a dialog stayed open", async () => {
    page.once("dialog", (d) => void setTimeout(() => void d.dismiss(), 300));
    await page.evaluate(() => window.confirm("Sure?"));
    await page.waitForTimeout(50);
    const [dialog] = await events();
    expect(dialog).toMatchObject({ type: "dialog", kind: "confirm", accepted: false });
    expect(dialog!.type === "dialog" && dialog!.openMs).toBeGreaterThanOrEqual(250);
  });

  it("reports a prompt that throws, and still throws", async () => {
    const thrown = await page.evaluate(() => {
      const w = window as unknown as { __defe2endDialogs: boolean; __dialogSrc: string };
      w.__defe2endDialogs = false;
      window.prompt = () => {
        throw new Error("prompt() is not supported");
      };
      (0, eval)(w.__dialogSrc);
      try {
        window.prompt("Name?");
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    });
    await page.waitForTimeout(50);
    expect(thrown).toBe("prompt() is not supported");
    expect(await events()).toMatchObject([{ type: "dialog", kind: "prompt", accepted: false }]);
  });

  it("applies testAttributes and menuLabels from each state, also mid-recording", async () => {
    const setState = (state: unknown) => page.evaluate((st) => (window as unknown as { __collector: { setState(s: unknown): void } }).__collector.setState(st), state);
    await page.click("#buy");
    await setState({ recording: true, tabId: "t1", testAttributes: ["data-track"], menuLabels: ["보임 확인", "보임 확인(경고만)", "텍스트 확인", "호버"] });
    await page.click("#buy");
    await page.click("#buy", { button: "right" });
    await page.click("[data-defe2end-menu] >> text=텍스트 확인");
    await setState({ recording: true, tabId: "t1" });
    await page.click("#buy", { delay: 0 });
    const list = await events();
    const selectors = list.map((e) => ("target" in e ? e.target.selectors : []));
    expect(selectors[0]).not.toContain('button[data-track="buy"]');
    expect(selectors[1]).toContain('button[data-track="buy"]');
    expect(list[2]).toMatchObject({ type: "contextmenu", check: "assertText" });
    // A state without the lists keeps the current ones.
    expect(selectors[3]).toContain('button[data-track="buy"]');
  });
});
