import { stepSchema } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import { convert, recordingResultSchema, type ConvertOptions, type ElementInfo, type RawEvent } from "./index.js";

const options: ConvertOptions = { startTabId: "t1", startUrl: "https://shop.test/list?page=2", device: "desktop", testAttributes: [] };
const top = (url = "https://shop.test/list") => ({ isSubframe: false, url });
const el = (selector: string, extra: Partial<ElementInfo> = {}): ElementInfo => ({ selectors: [selector, "text=fallback"], tagName: "button", ...extra });

let n = 0;
let clock = 1000;
/** Builds an event in tab t1, 1000 ms after the previous one unless `at` is given. */
function ev<T extends RawEvent["type"]>(type: T, fields: Omit<Extract<RawEvent, { type: T }>, "id" | "tabId" | "at" | "pageUrl" | "frame" | "type"> & Partial<RawEvent>): RawEvent {
  n++;
  clock = fields.at ?? clock + 1000;
  return { id: `e${n}`, tabId: "t1", pageUrl: "https://shop.test/list", frame: top(), ...fields, at: clock, type } as RawEvent;
}
const click = (selector: string, extra: Partial<ElementInfo> & { at?: number; tabId?: string; frame?: RawEvent["frame"] } = {}) => {
  const { at, tabId, frame, ...target } = extra;
  return ev("click", { target: el(selector, target), ...(at !== undefined && { at }), ...(tabId && { tabId }), ...(frame && { frame }) });
};

function run(events: RawEvent[], opts: Partial<ConvertOptions> = {}) {
  const result = convert(events, { ...options, ...opts });
  recordingResultSchema.parse(result);
  for (const step of result.steps) expect(stepSchema.safeParse(step).success).toBe(true);
  return result;
}
/** Steps between the goto and the screenshot, without ids. */
const body = (r: ReturnType<typeof run>) => r.steps.slice(1, -1).map(({ id: _id, ...s }) => s);
const bodySources = (r: ReturnType<typeof run>) => r.sourceEventIds.slice(1, -1);
const codes = (r: ReturnType<typeof run>) => r.warnings.map((w) => w.code);

describe("skeleton", () => {
  it("starts with goto to the start path and ends with a screenshot", () => {
    const r = run([]);
    expect(r.steps).toEqual([
      { id: "s1", action: "goto", name: "Start page", url: "/list?page=2" },
      { id: "s2", action: "screenshot", name: "Final screen" },
    ]);
    expect(r.sourceEventIds).toEqual([[], []]);
    expect(r.origin).toBe("https://shop.test");
  });
});

describe("click", () => {
  it("uses the first selector candidate and names the step from the text", () => {
    const r = run([click("button(Buy)", { text: "Buy" })]);
    expect(body(r)).toEqual([{ action: "click", name: 'Click "Buy"', selector: "button(Buy)" }]);
    expect(bodySources(r)).toEqual([["e" + n]]);
  });

  it("merges same-selector clicks under 800 ms, not at 800 ms", () => {
    const a = click("#a", { at: 10_000 });
    const b = click("#a", { at: 10_799 });
    const c = click("#a", { at: 11_599 });
    const r = run([a, b, c]);
    expect(body(r).map((s) => s.selector)).toEqual(["#a", "#a"]);
    expect(bodySources(r)).toEqual([[a.id, b.id], [c.id]]);
  });

  it("marks clicks inside an overlay as conditional", () => {
    const r = run([click("#close", { text: "Close", inOverlay: true })]);
    expect(body(r)).toEqual([{ action: "click", name: 'Click "Close" (conditional)', selector: "#close", optional: true, timeout: 5000 }]);
  });

  it("warns when there is no selector", () => {
    const e = ev("click", { target: { selectors: [], tagName: "div" } });
    const r = run([e]);
    expect(body(r)).toEqual([]);
    expect(r.warnings).toEqual([{ code: "noSelector", eventIds: [e.id] }]);
  });
});

describe("input, select, key", () => {
  it("overwrites the previous fill on the same selector", () => {
    const a = ev("input", { target: el("#q", { tagName: "input", placeholder: "Search" }), value: "sh", isPassword: false });
    const b = ev("input", { target: el("#q", { tagName: "input", placeholder: "Search" }), value: "shoes", isPassword: false });
    const r = run([a, b]);
    expect(body(r)).toEqual([{ action: "fill", name: 'Fill "Search"', selector: "#q", value: "shoes" }]);
    expect(bodySources(r)).toEqual([[a.id, b.id]]);
  });

  it("replaces passwords with {{PASSWORD}} and names the field", () => {
    const r = run([
      ev("input", { target: el("#pw", { tagName: "input", type: "password" }), value: "hunter2", isPassword: true }),
      ev("input", { target: el("#pw2", { tagName: "input", type: "password", placeholder: "PIN" }), value: "{{PASSWORD}}", isPassword: true }),
    ]);
    expect(body(r)).toEqual([
      { action: "fill", name: "Fill password", selector: "#pw", value: "{{PASSWORD}}" },
      { action: "fill", name: 'Fill "PIN"', selector: "#pw2", value: "{{PASSWORD}}" },
    ]);
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("records the selected option label", () => {
    const r = run([ev("select", { target: el("#size", { tagName: "select", text: "Size" }), label: "Medium" })]);
    expect(body(r)).toEqual([{ action: "select", name: 'Select "Size"', selector: "#size", value: "Medium" }]);
  });

  it("presses Enter and ignores IME composition", () => {
    const r = run([ev("key", { key: "Enter", target: el("#q"), composing: true }), ev("key", { key: "Enter", target: el("#q"), composing: false })]);
    expect(body(r)).toEqual([{ action: "pressKey", name: "Press Enter", selector: "#q", value: "Enter" }]);
    expect(bodySources(r)).toEqual([["e" + n]]);
  });
});

describe("navigation", () => {
  it("adds waitForUrl and assertUrl after an action", () => {
    const c = click("#go");
    const nav = ev("navigate", { url: "https://shop.test/item/7?ref=x", afterAction: true });
    const r = run([c, nav]);
    expect(body(r).slice(1)).toEqual([
      { action: "waitForUrl", name: "Wait for /item/7", expected: "*/item/7*", timeout: 30_000 },
      { action: "assertUrl", name: "Check URL /item/7", expected: "*/item/7*" },
    ]);
    expect(bodySources(r).slice(1)).toEqual([[nav.id], [nav.id]]);
  });

  it("moves the URL steps to where a redirect lands", () => {
    const nav = ev("navigate", { url: "https://shop.test/login", afterAction: true });
    const redirect = ev("navigate", { url: "https://shop.test/account", afterAction: false });
    const r = run([click("#go"), nav, redirect]);
    expect(body(r).slice(1).map((s) => s.expected)).toEqual(["*/account*", "*/account*"]);
    expect(bodySources(r).slice(1)).toEqual([[nav.id, redirect.id], [nav.id, redirect.id]]);
  });

  it("waits for the next target instead when the path is / or unchanged", () => {
    const home = ev("navigate", { url: "https://shop.test/", afterAction: true });
    const next = click("#banner", { text: "Sale" });
    const same = ev("navigate", { url: "https://shop.test/?tab=2", afterAction: true });
    const again = click("#banner");
    const r = run([click("#logo"), home, next, same, again]);
    expect(body(r).map((s) => s.action)).toEqual(["click", "waitForSelector", "click", "waitForSelector", "click"]);
    expect(body(r)[1]).toEqual({ action: "waitForSelector", name: 'Wait for "Sale"', selector: "#banner", timeout: 30_000 });
    expect(bodySources(r)[1]).toEqual([home.id, next.id]);
    expect(bodySources(r)[3]).toEqual([same.id, again.id]);
  });
});

describe("scroll", () => {
  const scroll = (y: number, edges: { atTop?: boolean; atBottom?: boolean } = {}) => ev("scroll", { y, atTop: edges.atTop ?? false, atBottom: edges.atBottom ?? false });

  it("keeps the last of consecutive stops as a px difference", () => {
    const a = scroll(300);
    const b = scroll(700);
    const r = run([a, b]);
    expect(body(r)).toEqual([{ action: "scroll", name: "Scroll 700px", value: "700" }]);
    expect(bodySources(r)).toEqual([[a.id, b.id]]);
  });

  it("uses bottom (each time) and top, and nothing for no change", () => {
    const r = run([scroll(0, { atTop: true }), scroll(5000, { atBottom: true }), scroll(9000, { atBottom: true }), scroll(0, { atTop: true }), click("#x"), scroll(0, { atTop: true })]);
    expect(body(r).map((s) => s.value ?? s.action)).toEqual(["bottom", "bottom", "top", "click"]);
  });

  it("measures from the previous stop and resets after navigation", () => {
    const r = run([scroll(400), click("#x"), scroll(1000), click("#y"), ev("navigate", { url: "https://shop.test/b", afterAction: true }), scroll(200)]);
    expect(body(r).filter((s) => s.action === "scroll").map((s) => s.value)).toEqual(["400", "600", "200"]);
  });
});

describe("hover and checks", () => {
  it("waits for a click target within 10 s of a hover", () => {
    const h = ev("contextmenu", { check: "hover", target: el("#menu", { text: "Menu" }) });
    const c = click("#sub", { text: "Shoes", at: clock + 9000 });
    const late = ev("contextmenu", { check: "hover", target: el("#menu") });
    const c2 = click("#sub", { at: clock + 10_001 });
    const r = run([h, c, late, c2]);
    expect(body(r).map((s) => s.action)).toEqual(["hover", "waitForSelector", "click", "hover", "click"]);
    expect(body(r)[1]).toEqual({ action: "waitForSelector", name: 'Wait for "Shoes"', selector: "#sub", timeout: 10_000 });
    expect(bodySources(r)[1]).toEqual([c.id]);
  });

  it("adds the picked checks", () => {
    const r = run([
      ev("contextmenu", { check: "assertVisible", target: el("#a") }),
      ev("contextmenu", { check: "assertVisibleOrWarn", target: el("#b") }),
      ev("contextmenu", { check: "assertText", target: el("#c"), text: "Total 3" }),
    ]);
    expect(body(r)).toEqual([
      { action: "assertVisible", name: "Check visible element", selector: "#a" },
      { action: "assertVisibleOrWarn", name: "Check visible (warn only) element", selector: "#b" },
      { action: "assertText", name: "Check text element", selector: "#c", expected: "Total 3" },
    ]);
  });

  it("drops a text check without text with a warning", () => {
    const e = ev("contextmenu", { check: "assertText", target: el("#c") });
    expect(codes(run([e]))).toEqual(["invalidStep"]);
  });
});

describe("dialogs", () => {
  it("merges a dialog within 2000 ms into the click", () => {
    const c1 = click("#del", { text: "Delete", at: 50_000 });
    const d1 = ev("dialog", { kind: "confirm", accepted: false, at: 52_000 });
    const c2 = click("#ok", { at: 60_000 });
    const d2 = ev("dialog", { kind: "alert", accepted: true, at: 60_500 });
    const r = run([c1, d1, c2, d2]);
    expect(body(r)).toEqual([
      { action: "clickAndDismissDialog", name: 'Click "Delete" + dismiss', selector: "#del" },
      { action: "clickAndAcceptDialog", name: "Click element + accept", selector: "#ok" },
    ]);
    expect(bodySources(r)).toEqual([[c1.id, d1.id], [c2.id, d2.id]]);
  });

  it("warns for late dialogs and prompts", () => {
    const c = click("#x", { at: 70_000 });
    const late = ev("dialog", { kind: "confirm", accepted: true, at: 72_001 });
    const prompt = ev("dialog", { kind: "prompt", accepted: true });
    const r = run([c, late, prompt]);
    expect(body(r).map((s) => s.action)).toEqual(["click"]);
    expect(r.warnings).toEqual([
      { code: "dialogUnmatched", eventIds: [late.id] },
      { code: "dialogPrompt", eventIds: [prompt.id] },
    ]);
  });
});

describe("popups", () => {
  const inPopup = { tabId: "p1", pageUrl: "https://pay.test/checkout", frame: top("https://pay.test/checkout") };

  it("promotes the opening click and converts the popup's allowed actions", () => {
    const c = click("#pay", { text: "Pay", at: 100_000 });
    const open = ev("popupOpen", { tabId: "p1", openerTabId: "t1", url: "https://pay.test/checkout", at: 101_000 });
    const nav = ev("navigate", { ...inPopup, url: "https://pay.test/checkout", afterAction: false });
    const fill = ev("input", { ...inPopup, target: el("#card", { tagName: "input", type: "password" }), value: "{{PASSWORD}}", isPassword: true });
    const ok = ev("click", { ...inPopup, target: el("#confirm", { text: "Confirm" }) });
    const check = ev("contextmenu", { ...inPopup, check: "assertVisible", target: el("#done") });
    const key = ev("key", { ...inPopup, key: "Enter", target: el("#card"), composing: false });
    const scroll = ev("scroll", { ...inPopup, y: 100, atTop: false, atBottom: false });
    const meanwhile = click("#elsewhere");
    const close = ev("popupClose", { tabId: "p1" });
    const r = run([c, open, nav, fill, ok, check, key, scroll, meanwhile, close]);
    expect(body(r)).toEqual([
      { action: "clickAndWaitPopup", name: 'Click "Pay" + new window', selector: "#pay" },
      { action: "assertPopupUrl", name: "Check new window URL", expected: "*/checkout*" },
      { action: "fillInPopup", name: "Fill password", selector: "#card", value: "{{PASSWORD}}" },
      { action: "clickInPopup", name: 'Click "Confirm"', selector: "#confirm" },
      { action: "assertVisibleInPopup", name: "Check visible element", selector: "#done" },
      { action: "closePopup", name: "Close new window" },
    ]);
    expect(bodySources(r)[0]).toEqual([c.id, open.id]);
    expect(bodySources(r)[1]).toEqual([nav.id]);
    expect(r.warnings).toEqual([
      { code: "popupUnsupported", eventIds: [key.id, scroll.id], count: 2 },
      { code: "popupOpenerEvent", eventIds: [meanwhile.id], count: 1 },
    ]);
    void nav;
  });

  it("closes a popup left open and warns", () => {
    const open = ev("popupOpen", { tabId: "p1", openerTabId: "t1", url: "about:blank", at: clock + 500 });
    const c = click("#a", { at: open.at - 400 });
    const nav = ev("navigate", { ...inPopup, url: "https://pay.test/start", afterAction: false });
    const r = run([c, open, nav]);
    expect(body(r).map((s) => s.action)).toEqual(["clickAndWaitPopup", "assertPopupUrl", "closePopup"]);
    expect(body(r)[1]!.expected).toBe("*/start*");
    expect(bodySources(r)[2]).toEqual([open.id]);
    expect(codes(r)).toEqual(["popupNotClosed"]);
  });

  it("drops popups without a trigger click, nested popups and other tabs", () => {
    const open = ev("popupOpen", { tabId: "p1", openerTabId: "t1", url: "https://pay.test/" });
    const inside = ev("click", { ...inPopup, target: el("#x") });
    const nested = ev("popupOpen", { tabId: "p2", openerTabId: "p1", url: "https://pay.test/deeper" });
    const other1 = click("#y", { tabId: "t9" });
    const other2 = click("#z", { tabId: "t9" });
    const r = run([open, inside, nested, other1, other2]);
    expect(body(r)).toEqual([]);
    expect(r.warnings).toEqual([
      { code: "popupNoTrigger", eventIds: [open.id] },
      { code: "popupNested", eventIds: [nested.id] },
      { code: "otherTab", eventIds: [other1.id, other2.id], count: 2 },
    ]);
  });
});

describe("iframes", () => {
  const frame = { isSubframe: true, url: "https://pay.test/widget/card-form?id=1" };

  it("clicks and fills inside iframe[src*=path]", () => {
    const c = ev("click", { frame, target: el("#num") });
    const a = ev("input", { frame, target: el("#num", { tagName: "input" }), value: "4111", isPassword: false });
    const b = ev("input", { frame, target: el("#num", { tagName: "input" }), value: "4111 1111", isPassword: false });
    const r = run([c, a, b]);
    expect(body(r)).toEqual([
      { action: "clickInIframe", name: "Click element", selector: 'iframe[src*="/widget/card-form"]', value: "#num" },
      { action: "fillInIframe", name: "Fill field", selector: 'iframe[src*="/widget/card-form"]', value: "#num", expected: "4111 1111" },
    ]);
    expect(bodySources(r)[1]).toEqual([a.id, b.id]);
  });

  it("skips select, key and root-path frames with warnings", () => {
    const sel = ev("select", { frame, target: el("#m"), label: "May" });
    const key = ev("key", { frame, key: "Enter", target: el("#m"), composing: false });
    const root = ev("click", { frame: { isSubframe: true, url: "https://pay.test/" }, target: el("#m") });
    const r = run([sel, key, root]);
    expect(body(r)).toEqual([]);
    expect(codes(r)).toEqual(["iframeUnsupported", "iframeUnsupported", "iframeRootPath"]);
  });
});

describe("step names", () => {
  it("uses the Korean messages with locale ko", () => {
    const c = click("#del", { text: "삭제", inOverlay: true, at: 200_000 });
    const pw = ev("input", { target: el("#pw", { tagName: "input", type: "password" }), value: "{{PASSWORD}}", isPassword: true });
    const go = click("#go", { at: 300_000 });
    const d = ev("dialog", { kind: "confirm", accepted: true, at: 300_500 });
    const nav = ev("navigate", { url: "https://shop.test/done", afterAction: true });
    const r = run([c, pw, go, d, nav, ev("scroll", { y: 0, atTop: false, atBottom: true })], { locale: "ko" });
    expect(r.steps.map((s) => s.name)).toEqual([
      "시작 페이지",
      "「삭제」 클릭 (조건부)",
      "비밀번호 입력",
      "요소 클릭 + 확인",
      "/done 이동 대기",
      "/done URL 확인",
      "맨 아래로 스크롤",
      "최종 화면",
    ]);
  });
});

describe("review fixes (round 1)", () => {
  it("drops the URL steps when a redirect lands on / and waits before the next action", () => {
    const c = click("#login");
    const nav = ev("navigate", { url: "https://shop.test/login", afterAction: true });
    const home = ev("navigate", { url: "https://shop.test/", afterAction: false });
    const next = click("#menu", { text: "Menu" });
    const r = run([c, nav, home, next]);
    expect(body(r).map((s) => s.action)).toEqual(["click", "waitForSelector", "click"]);
    expect(bodySources(r)[1]).toEqual([nav.id, home.id, next.id]);
    expect(r.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("drops the URL steps when a redirect returns to the path it left", () => {
    const r = run([click("#a"), ev("navigate", { url: "https://shop.test/sso", afterAction: true }), ev("navigate", { url: "https://shop.test/list?x=1", afterAction: false }), click("#b")]);
    expect(body(r).map((s) => s.action)).toEqual(["click", "waitForSelector", "click"]);
  });

  it("checks the popup URL where it lands, not where it was asked to open", () => {
    const c = click("#pay", { at: 400_000 });
    const open = ev("popupOpen", { tabId: "p1", openerTabId: "t1", url: "https://pay.test/redirect?to=checkout", at: 400_500 });
    const land = ev("navigate", { tabId: "p1", pageUrl: "https://pay.test/checkout", url: "https://pay.test/checkout", afterAction: false });
    const r = run([c, open, land, ev("popupClose", { tabId: "p1" })]);
    expect(body(r)[1]).toEqual({ action: "assertPopupUrl", name: "Check new window URL", expected: "*/checkout*" });
    expect(bodySources(r)[1]).toEqual([land.id]);
  });

  it("does not merge same-selector clicks or fills across a navigation", () => {
    const a = click("#tab", { at: 500_000 });
    const nav = ev("navigate", { url: "https://shop.test/list?tab=2", afterAction: true, at: 500_100 });
    const b = click("#tab", { at: 500_300 });
    const f1 = ev("input", { target: el("#q", { tagName: "input" }), value: "a", isPassword: false });
    const nav2 = ev("navigate", { url: "https://shop.test/list?q=a", afterAction: true });
    const f2 = ev("input", { target: el("#q", { tagName: "input" }), value: "b", isPassword: false });
    const r = run([a, nav, b, f1, nav2, f2]);
    expect(body(r).map((s) => s.action)).toEqual(["click", "waitForSelector", "click", "fill", "waitForSelector", "fill"]);
    expect(bodySources(r)).toEqual([[a.id], [nav.id, b.id], [b.id], [f1.id], [nav2.id, f2.id], [f2.id]]);
  });
});

describe("time window edges", () => {
  it("merges a dialog at exactly 2000 ms and promotes a popup at 2000 ms but not 2001 ms", () => {
    const c = click("#x", { at: 600_000 });
    const d = ev("dialog", { kind: "alert", accepted: true, at: 602_000 });
    expect(body(run([c, d]))[0]!.action).toBe("clickAndAcceptDialog");
    const c2 = click("#y", { at: 700_000 });
    const late = ev("popupOpen", { tabId: "p1", openerTabId: "t1", url: "about:blank", at: 702_001 });
    expect(codes(run([c2, late]))).toEqual(["popupNoTrigger"]);
    const c3 = click("#y", { at: 800_000 });
    const onTime = ev("popupOpen", { tabId: "p1", openerTabId: "t1", url: "about:blank", at: 802_000 });
    expect(body(run([c3, onTime])).map((s) => s.action)).toEqual(["clickAndWaitPopup", "closePopup"]);
  });

  it("does not merge a dialog into a step that is no longer a plain click", () => {
    const c = click("#x", { at: 900_000 });
    const d1 = ev("dialog", { kind: "alert", accepted: true, at: 900_500 });
    const d2 = ev("dialog", { kind: "alert", accepted: true, at: 901_000 });
    const r = run([c, d1, d2]);
    expect(body(r).map((s) => s.action)).toEqual(["clickAndAcceptDialog"]);
    expect(r.warnings).toEqual([{ code: "dialogUnmatched", eventIds: [d2.id] }]);
  });
});
