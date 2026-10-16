import { messages } from "@defe2end/i18n";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { desktopBridge, RecordButton } from "./recorder-panel";

const fn = () => vi.fn();
const fullApi = () => ({
  sideBrowser: { open: fn(), close: fn(), setBounds: fn(), navigate: fn(), setDragging: fn(), setDevice: fn(), saveSession: fn() },
  recorder: { start: fn(), stop: fn(), discard: fn(), onResult: fn(), onCheckRequested: fn() },
});

describe("recording entry", () => {
  it("finds the preload API only inside the desktop app", () => {
    expect(desktopBridge(undefined)).toBeNull();
    expect(desktopBridge({})).toBeNull();
    expect(desktopBridge({ defe2end: { version: "1.0.0" } })).toBeNull();
    const partial = fullApi();
    delete (partial.recorder as Partial<typeof partial.recorder>).discard;
    expect(desktopBridge({ defe2end: partial })).toBeNull();
    const api = fullApi();
    expect(desktopBridge({ defe2end: api })).toBe(api);
  });

  it("renders no Record button without the preload (server render, plain browser)", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages.en}>
        <RecordButton onOpen={() => {}} />
      </NextIntlClientProvider>,
    );
    expect(html).toBe("");
  });
});
