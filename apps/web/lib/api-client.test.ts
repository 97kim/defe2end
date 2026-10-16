import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api-client";

afterEach(() => vi.unstubAllGlobals());

const respond = (body: BodyInit | null, init: ResponseInit = {}) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, init)));

describe("api", () => {
  it("returns the parsed body of a JSON success", async () => {
    respond(JSON.stringify({ slug: "shop" }), { status: 201 });
    expect(await api("/x", "POST", {})).toEqual({ ok: true, status: 201, data: { slug: "shop" } });
  });

  it("treats 204 No Content as success without data", async () => {
    respond(null, { status: 204 });
    expect(await api("/x", "DELETE")).toEqual({ ok: true, status: 204 });
  });

  it.each([
    ["an HTML page", "<html>proxy</html>"],
    ["a truncated body", '{"slug":'],
    ["an empty body", ""],
  ])("treats a 200 with %s as an error", async (_, body) => {
    respond(body, { status: 200, statusText: "OK" });
    const res = await api("/x");
    expect(res).toMatchObject({ ok: false, status: 200, error: { code: "bad_response" } });
    expect(res.data).toBeUndefined();
    expect(res.error!.message).toMatch(/200 OK without a readable JSON body/);
  });

  it("treats a non-JSON error page as an error with a clear message", async () => {
    respond("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" });
    expect(await api("/x")).toEqual({
      ok: false,
      status: 502,
      error: { code: "bad_response", message: "The server answered 502 Bad Gateway without a readable JSON body" },
    });
  });

  it("passes our JSON error through", async () => {
    respond(JSON.stringify({ error: { code: "forbidden", message: "No" } }), { status: 403 });
    expect(await api("/x")).toEqual({ ok: false, status: 403, error: { code: "forbidden", message: "No" } });
  });

  it("reports a network failure as status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(await api("/x")).toEqual({ ok: false, status: 0, error: { code: "network", message: "fetch failed" } });
  });
});
