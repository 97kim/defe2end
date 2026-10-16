import { describe, expect, it } from "vitest";
import { isAllowedNavigation } from "./navigation.js";

const page = "file:///Applications/defE2End.app/Contents/Resources/app.asar/static/index.html";

describe("isAllowedNavigation", () => {
  it("allows the bundled page, ignoring query and hash", () => {
    expect(isAllowedNavigation(page, page)).toBe(true);
    expect(isAllowedNavigation(`${page}?a=1#top`, page)).toBe(true);
  });

  it("refuses remote URLs", () => {
    expect(isAllowedNavigation("https://example.com/", page)).toBe(false);
    expect(isAllowedNavigation("http://localhost:3000/", page)).toBe(false);
  });

  it("refuses other local files", () => {
    expect(isAllowedNavigation("file:///etc/passwd", page)).toBe(false);
    expect(isAllowedNavigation(page.replace("index.html", "other.html"), page)).toBe(false);
  });

  it("refuses script and data URLs and garbage", () => {
    expect(isAllowedNavigation("javascript:alert(1)", page)).toBe(false);
    expect(isAllowedNavigation("data:text/html,hi", page)).toBe(false);
    expect(isAllowedNavigation("not a url", page)).toBe(false);
  });
});
