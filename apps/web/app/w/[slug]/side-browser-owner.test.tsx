import { messages } from "@defe2end/i18n";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { claimForRecorder, sideBrowserOwner, subscribeSideBrowserOwner, wireColumn } from "./side-browser-owner";
import { SideBrowserPanel } from "./side-browser-panel";

describe("side browser owner", () => {
  it("is the workspace column outside the editor, so an AI open request is answered on any page", () => {
    expect(sideBrowserOwner()).toBe("workspace");
  });

  it("goes to the recorder panel while it is open, and back after", () => {
    const seen: string[] = [];
    const off = subscribeSideBrowserOwner(() => seen.push(sideBrowserOwner()));
    const release = claimForRecorder();
    expect(sideBrowserOwner()).toBe("recorder");
    release();
    release(); // twice is harmless
    expect(sideBrowserOwner()).toBe("workspace");
    expect(seen).toEqual(["recorder", "workspace"]);
    off();
  });

  it("renders no column without the preload (server render, plain browser)", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages.en}>
        <SideBrowserPanel />
      </NextIntlClientProvider>,
    );
    expect(html).toBe("");
  });
});

describe("workspace column wiring", () => {
  const setup = () => {
    let request: (() => void) | undefined;
    let sync: (() => void) | undefined;
    const bridge = {
      sideBrowser: { open: vi.fn(async () => {}), setBounds: vi.fn(async () => {}), close: vi.fn(async () => {}) },
      mcp: { onOpenRequested: (l: () => void) => ((request = l), () => (request = undefined)) },
    };
    let box = { x: 300, y: 28, width: 480, height: 700 };
    const unwatch = vi.fn();
    const teardown = wireColumn({ bridge, bounds: () => box, watch: (s) => ((sync = s), unwatch), onError: () => {} });
    return { bridge, teardown, unwatch, request: () => request?.(), sync: () => sync?.(), move: (b: typeof box) => (box = b) };
  };

  it("opens the browser again on every AI request while the column stays open (e.g. its last tab was closed)", () => {
    const c = setup();
    expect(c.bridge.sideBrowser.open).toHaveBeenCalledTimes(1);
    c.move({ x: 300, y: 0, width: 480, height: 700 });
    c.request();
    expect(c.bridge.sideBrowser.open).toHaveBeenCalledTimes(2);
    expect(c.bridge.sideBrowser.open).toHaveBeenLastCalledWith(undefined, { x: 300, y: 0, width: 480, height: 700 });
    c.teardown();
  });

  it("sends the current area when the watcher fires (slide-in end, chat panel opening or closing)", () => {
    const c = setup();
    c.move({ x: 0, y: 0, width: 480, height: 700 });
    c.sync();
    expect(c.bridge.sideBrowser.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 480, height: 700 });
    c.teardown();
    expect(c.unwatch).toHaveBeenCalled();
    expect(c.bridge.sideBrowser.close).toHaveBeenCalledTimes(1);
  });

  it("leaves requests and the browser to the recorder panel once it takes over", () => {
    const c = setup();
    const release = claimForRecorder();
    c.request();
    expect(c.bridge.sideBrowser.open).toHaveBeenCalledTimes(1);
    c.teardown();
    expect(c.bridge.sideBrowser.close).not.toHaveBeenCalled();
    release();
  });
});
