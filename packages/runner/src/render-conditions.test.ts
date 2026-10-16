import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { collectRenderConditions, detectRuntime, fontSetId, renderConditionDiff, type RenderConditions } from "./render-conditions.js";
import { SANDBOX } from "./test-support.js";

describe("detectRuntime", () => {
  it("tells the server from the desktop app per platform", () => {
    expect(detectRuntime({ desktop: false, platform: "darwin" })).toBe("server");
    expect(detectRuntime({ desktop: false, platform: "linux" })).toBe("server");
    expect(detectRuntime({ desktop: true, platform: "darwin" })).toBe("desktop-mac");
    expect(detectRuntime({ desktop: true, platform: "win32" })).toBe("desktop-windows");
    expect(() => detectRuntime({ desktop: true, platform: "linux" })).toThrow();
  });
});

describe("fontSetId", () => {
  it("keys the desktop font set by OS major release", () => {
    expect(fontSetId({ runtime: "desktop-mac", platform: "darwin", osRelease: "25.6.0" })).toBe("desktop-mac/darwin-25");
    expect(fontSetId({ runtime: "desktop-mac", platform: "darwin", osRelease: "25.1.0" })).toBe("desktop-mac/darwin-25");
    expect(fontSetId({ runtime: "desktop-windows", platform: "win32", osRelease: "10.0.22631" })).toBe("desktop-windows/windows-10.0.22631");
  });

  it("keys the server font set by its image label", () => {
    expect(fontSetId({ runtime: "server", platform: "linux", osRelease: "6.8.0-1-aws" })).toBe("server/linux");
    expect(fontSetId({ runtime: "server", platform: "linux", osRelease: "6.9.0", imageFonts: "noto-2026.10" })).toBe("server/linux/noto-2026.10");
  });
});

describe("collectRenderConditions", () => {
  it("reads browser version, scale, viewport and font set from the page", async () => {
    const browser = await chromium.launch({ chromiumSandbox: SANDBOX });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      const got = await collectRenderConditions(page, { runtime: "server", maskPolicyVersion: 1 });
      expect(got).toEqual({
        browserVersion: browser.version(),
        deviceScaleFactor: 2,
        viewport: { width: 390, height: 844 },
        fontSet: `server/${process.platform}`,
        maskPolicyVersion: 1,
      });
      expect((await collectRenderConditions(page, { runtime: "server", maskPolicyVersion: 1, browserVersion: "given" })).browserVersion).toBe("given");
    } finally {
      await browser.close();
    }
  });
});

describe("renderConditionDiff", () => {
  const base: RenderConditions = { browserVersion: "140.0", deviceScaleFactor: 1, viewport: { width: 1280, height: 800 }, fontSet: "server/linux", maskPolicyVersion: 1 };
  it("lists what differs", () => {
    expect(renderConditionDiff(base, { ...base })).toEqual([]);
    expect(renderConditionDiff(base, { ...base, browserVersion: "141.0", viewport: { width: 1280, height: 801 }, maskPolicyVersion: 2 })).toEqual([
      "browserVersion",
      "viewport",
      "maskPolicyVersion",
    ]);
    expect(renderConditionDiff(base, { ...base, deviceScaleFactor: 2, fontSet: "desktop-mac/darwin-25" })).toEqual(["deviceScaleFactor", "fontSet"]);
  });
});
