import { messages } from "@defe2end/i18n";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { claimForRecorder, sideBrowserOwner, subscribeSideBrowserOwner } from "./side-browser-owner";
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
