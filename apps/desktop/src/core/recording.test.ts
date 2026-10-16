import { describe, expect, it, vi } from "vitest";
import type { ConvertOptions, RawEvent, RecordingResult } from "@defe2end/recorder";
import { Recording } from "./recording.js";

const target = { selectors: ["#go"], tagName: "button" };

function make() {
  const calls: { events: RawEvent[]; options: ConvertOptions }[] = [];
  const convert = vi.fn((events: readonly RawEvent[], options: ConvertOptions): RecordingResult => {
    calls.push({ events: [...events], options });
    return { steps: [], sourceEventIds: [], warnings: [], origin: "", eventCount: events.length, device: options.device };
  });
  let clock = 1_000;
  const recording = new Recording({ startTabId: "tab-1", startUrl: "https://shop.test/", device: "desktop", testAttributes: ["data-qa"], locale: "ko", convert, now: () => clock++ });
  return { recording, calls };
}

describe("Recording", () => {
  it("stamps id, tab, time and page URL itself, whatever the tab sent", () => {
    const { recording, calls } = make();
    const ok = recording.fromTab("tab-1", "https://shop.test/list", { id: "spoofed", tabId: "tab-9", at: 1, pageUrl: "https://evil.test/", type: "click", target, frame: { isSubframe: false, url: "https://shop.test/list" } });
    expect(ok).toBe(true);
    expect(recording.fromTab("tab-1", "https://shop.test/", { type: "nonsense" })).toBe(false);
    recording.result();
    expect(calls[0]!.events[0]).toMatchObject({ id: "e1", tabId: "tab-1", at: 1_000, pageUrl: "https://shop.test/list" });
    expect(calls[0]!.options).toEqual({ startTabId: "tab-1", startUrl: "https://shop.test/", device: "desktop", testAttributes: ["data-qa"], locale: "ko" });
  });

  it("marks navigation after an action, records popups, and discards events by id", () => {
    const { recording, calls } = make();
    recording.navigate("tab-1", "https://shop.test/a");
    recording.fromTab("tab-1", "https://shop.test/a", { type: "click", target, frame: { isSubframe: false, url: "https://shop.test/a" } });
    recording.navigate("tab-1", "https://shop.test/b");
    recording.popupOpen("tab-1", "tab-2", "https://pay.test/");
    recording.popupClose("tab-2", "https://pay.test/");
    recording.discard(["e2"]);
    recording.result();
    const events = calls[0]!.events;
    expect(events.map((e) => e.id)).toEqual(["e1", "e3", "e4", "e5"]);
    expect(events[0]).toMatchObject({ type: "navigate", afterAction: false });
    expect(events[1]).toMatchObject({ type: "navigate", afterAction: true });
    expect(events[2]).toMatchObject({ type: "popupOpen", tabId: "tab-2", openerTabId: "tab-1" });
  });

  it("dates a dialog at its opening and records an in-page navigation once", () => {
    const { recording, calls } = make();
    recording.fromTab("tab-1", "https://shop.test/", { type: "dialog", kind: "confirm", accepted: true, openMs: 600, frame: { isSubframe: false, url: "https://shop.test/" } });
    recording.navigate("tab-1", "https://shop.test/#step2", "in-page");
    recording.navigate("tab-1", "https://shop.test/#step2", "in-page");
    recording.result();
    const events = calls[0]!.events;
    expect(events[0]).toMatchObject({ type: "dialog", at: 400 });
    expect(events.filter((e) => e.type === "navigate")).toHaveLength(1);
  });

  it("keeps a reload of the same URL as a navigation, so clicks before and after stay apart", () => {
    const { recording, calls } = make();
    const click = { type: "click", target, frame: { isSubframe: false, url: "https://shop.test/a" } };
    recording.navigate("tab-1", "https://shop.test/a");
    recording.fromTab("tab-1", "https://shop.test/a", click);
    recording.navigate("tab-1", "https://shop.test/a");
    recording.fromTab("tab-1", "https://shop.test/a", click);
    recording.result();
    expect(calls[0]!.events.map((e) => e.type)).toEqual(["navigate", "click", "navigate", "click"]);
    expect(calls[0]!.events[2]).toMatchObject({ type: "navigate", afterAction: true });
  });
});
