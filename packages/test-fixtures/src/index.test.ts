import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FixtureServer, startFixtureServer } from "./index.js";

describe("startFixtureServer", () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixtureServer();
  });
  afterAll(() => server.close());

  it.each(["/", "/login.html", "/products.html", "/product.html?id=1", "/cart.html", "/order-complete.html", "/network.html", "/actions.html", "/frame.html", "/frames.html", "/popup.html", "/open-popup.html", "/unexpected-dialog.html", "/service-worker.html", "/websocket.html"])(
    "serves %s as HTML",
    async (path) => {
      const res = await fetch(server.url + path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("<!doctype html>");
    },
  );

  it("serves the shared script", async () => {
    const res = await fetch(`${server.url}/shop.js`);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("answers /api/status with the asked status", async () => {
    const res = await fetch(`${server.url}/api/status?code=201`, { method: "POST" });
    expect([res.status, await res.json()]).toEqual([201, { method: "POST" }]);
  });

  it("redirects /redirect?to=", async () => {
    const res = await fetch(`${server.url}/redirect?to=${encodeURIComponent("https://example.com/")}`, { redirect: "manual" });
    expect([res.status, res.headers.get("location")]).toEqual([302, "https://example.com/"]);
  });

  it.each(["/missing.html", "/../package.json", "/%2e%2e/package.json"])("returns 404 for %s", async (path) => {
    expect((await fetch(server.url + path)).status).toBe(404);
  });
});
