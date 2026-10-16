import { describe, expect, it } from "vitest";
import { convert, rawEventSchema, recordingResultSchema, type RawEvent } from "./index.js";

const top = { isSubframe: false, url: "https://shop.test/" };
const button = { selectors: ["role=button[name=\"Buy\"]", "text=Buy"], tagName: "button", text: "Buy" };

const events: RawEvent[] = [
  { id: "e1", tabId: "t1", at: 1, pageUrl: "https://shop.test/", frame: top, type: "click", target: button },
  { id: "e2", tabId: "t1", at: 2, pageUrl: "https://shop.test/", frame: top, type: "input", target: { selectors: ["input[name=\"pw\"]"], tagName: "input", type: "password" }, value: "{{PASSWORD}}", isPassword: true },
  { id: "e3", tabId: "t1", at: 3, pageUrl: "https://shop.test/", frame: top, type: "dialog", kind: "confirm", accepted: false },
  { id: "e4", tabId: "t2", at: 4, pageUrl: "https://pay.test/", frame: { isSubframe: true, url: "https://pay.test/frame" }, type: "popupOpen", openerTabId: "t1", url: "https://pay.test/" },
];

describe("raw events", () => {
  it("parse every kind and reject unknown fields", () => {
    for (const e of events) expect(rawEventSchema.parse(e)).toEqual(e);
    expect(rawEventSchema.safeParse({ ...events[0], extra: 1 }).success).toBe(false);
    expect(rawEventSchema.safeParse({ ...events[0], type: "tabSwitch" }).success).toBe(false);
  });
});

describe("recording result", () => {
  it("keeps origin, event count and device", () => {
    const result = convert(events, { startTabId: "t1", startUrl: "https://shop.test/cart?x=1", device: "mobile", testAttributes: [] });
    expect(recordingResultSchema.parse(result)).toMatchObject({ origin: "https://shop.test", eventCount: 4, device: "mobile" });
  });

  it("the result keeps one sourceEventIds entry per step", () => {
    const step = { id: "s1", action: "goto", url: "/" };
    expect(recordingResultSchema.safeParse({ steps: [step], sourceEventIds: [], warnings: [], origin: "", eventCount: 0, device: "desktop" }).success).toBe(false);
    expect(recordingResultSchema.safeParse({ steps: [step], sourceEventIds: [["e1"]], warnings: [], origin: "", eventCount: 1, device: "desktop" }).success).toBe(true);
  });
});
