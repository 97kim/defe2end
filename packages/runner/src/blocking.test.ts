// Network blocking in a real browser: every IP spelling, redirects, iframes, popups,
// service workers and WebSockets, with and without private-range blocking.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Step } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import { execute, makePlan, useFixtures } from "./test-support.js";

const fixtures = useFixtures();
/** With private ranges blocked the loopback fixture server is reached under this name (test-only alias). */
const ALIAS = "fixture.test";
const privatePlan = (steps: Step[]) =>
  makePlan(`http://${ALIAS}:${fixtures.port}`, steps, { network: { blockPrivateNetworks: true } });
const privateRun = (steps: Step[]) => execute(privatePlan(steps), { internals: { hostAliases: { [ALIAS]: "127.0.0.1" } } });
const via = (to: string) => `/redirect?to=${encodeURIComponent(to)}`;
const goto = (url: string, id = "n"): Step => ({ id, action: "goto", url, timeout: 5_000 });
/**
 * A blocked navigation fails its run even when optional (spec 2.9), so each URL gets a run of its own, a few
 * at a time. Returns each run's last step error code and its logs.
 */
async function eachBlocked(urls: string[], runOne: (steps: Step[]) => Promise<{ results: { errorCode?: string }[]; logs: string[] }>, first: Step[] = []) {
  const out: { url: string; code?: string; logs: string[] }[] = [];
  for (let i = 0; i < urls.length; i += 5) {
    const batch = await Promise.all(urls.slice(i, i + 5).map((url) => runOne([...first, goto(url)])));
    batch.forEach((r, j) => out.push({ url: urls[i + j]!, code: r.results.at(-1)?.errorCode, logs: r.logs }));
  }
  return out;
}
const codes = (out: { url: string; code?: string }[]) => out.map((o) => [o.url, o.code]);
const allBlocked = (out: { url: string }[]) => out.map((o) => [o.url, "blocked_request"]);

describe("metadata addresses (always blocked)", () => {
  const forms = [
    "http://169.254.169.254/latest/",
    "http://2852039166/latest/",
    "http://0xa9fea9fe/latest/",
    "http://0251.0376.0251.0376/latest/",
    "http://169.254.43518/latest/",
    "http://[::ffff:169.254.169.254]/latest/",
    "http://[::ffff:a9fe:a9fe]/latest/",
    "http://[fd00:ec2::254]/latest/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://[fe80::1]/",
  ];

  it("refuses every spelling, directly and behind a redirect, without waiting for a timeout", async () => {
    const started = Date.now();
    const out = await eachBlocked([...forms, ...forms.map(via)], (steps) => execute(makePlan(fixtures.url, steps)));
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(codes(out)).toEqual(allBlocked(out));
  });
});

describe("private ranges (setting)", () => {
  const port = () => fixtures.port;
  const loopbackForms = () => [
    `http://127.0.0.1:${port()}/actions.html`,
    `http://2130706433:${port()}/actions.html`,
    `http://0x7f000001:${port()}/actions.html`,
    `http://0177.0.0.1:${port()}/actions.html`,
    `http://127.1:${port()}/actions.html`,
    `http://[::ffff:127.0.0.1]:${port()}/actions.html`,
    `http://[::1]:${port()}/actions.html`,
    `http://localhost:${port()}/actions.html`,
  ];

  it("blocks loopback in every spelling, directly and behind redirects, but not the allowed name", async () => {
    const urls = [...loopbackForms(), ...loopbackForms().map(via), via("http://10.0.0.1/"), via("http://192.168.0.1/"), via("http://172.20.0.1/"), via("http://100.64.0.1/"), via("http://[fd12::1]/")];
    const ok = await privateRun([goto("/actions.html")]);
    expect(ok.results[0]!.status).toBe("passed");
    const out = await eachBlocked(urls, privateRun);
    expect(codes(out)).toEqual(allBlocked(out));
    expect(out.flatMap((o) => o.logs)).toEqual(expect.arrayContaining([expect.stringContaining("Blocked request to http://10.0.0.1/")]));
  });

  it("blocks trailing-dot names behind a redirect, and the target is never hit", async () => {
    let hits = 0;
    const target = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/html" }).end("<p>hit</p>");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as AddressInfo).port;
    try {
      const out = await eachBlocked(
        [via(`http://localhost.:${targetPort}/hit`), via(`http://foo.localhost.:${targetPort}/hit`), via("http://metadata.google.internal./computeMetadata/v1/")],
        privateRun,
      );
      expect(codes(out)).toEqual(allBlocked(out));
      expect(hits).toBe(0);
      // Control: with the setting off the same redirect does reach the server.
      await execute(makePlan(fixtures.url, [goto(via(`http://localhost.:${targetPort}/hit`))]));
      expect(hits).toBeGreaterThan(0);
    } finally {
      await new Promise((resolve) => target.close(resolve));
    }
  });

  it("lets the same redirect through when the setting is off", async () => {
    const { results } = await execute(makePlan(fixtures.url, [goto(via(`http://127.0.0.1:${fixtures.port}/actions.html`))]));
    expect(results[0]!.status).toBe("passed");
  });
});

describe("frames, popups, service workers, WebSockets", () => {
  it("blocks an iframe that redirects into a blocked address", async () => {
    const { logs } = await execute(
      makePlan(fixtures.url, [
        { id: "f", action: "goto", url: `/frames.html?to=${encodeURIComponent("http://169.254.169.254/frame")}` },
        { id: "w", action: "wait", timeout: 300 },
      ]),
    );
    expect(logs).toEqual(expect.arrayContaining([expect.stringContaining("Blocked request to http://169.254.169.254/frame")]));
    const priv = await privateRun([
      { id: "f", action: "goto", url: `/frames.html?to=${encodeURIComponent(`http://127.0.0.1:${fixtures.port}/popup.html`)}` },
      { id: "w", action: "wait", timeout: 300 },
    ]);
    expect(priv.logs).toEqual(expect.arrayContaining([expect.stringContaining(`Blocked request to http://127.0.0.1:${fixtures.port}/popup.html`)]));
  });

  it("blocks a popup opened to a blocked address", async () => {
    const { logs } = await execute(
      makePlan(fixtures.url, [
        { id: "o", action: "goto", url: `/open-popup.html?to=${encodeURIComponent("http://0xa9fea9fe/popup")}` },
        { id: "c", action: "click", selector: "#open" },
        { id: "w", action: "wait", timeout: 300 },
      ]),
    );
    expect(logs).toEqual(expect.arrayContaining([expect.stringContaining("Blocked request to http://169.254.169.254/popup")]));
  });

  it("refuses service worker registration", async () => {
    const { results } = await execute(
      makePlan(fixtures.url, [
        { id: "o", action: "goto", url: "/service-worker.html" },
        { id: "r", action: "waitForSelector", selector: "#sw-result:is(:text-matches('^(refused|unavailable)'))" },
      ]),
    );
    expect(results.map((r) => r.status)).toEqual(["passed", "passed"]);
  });

  it("applies the same rule to WebSockets", async () => {
    const meta = await execute(
      makePlan(fixtures.url, [
        { id: "o", action: "goto", url: `/websocket.html?to=${encodeURIComponent("ws://169.254.169.254/socket")}` },
        { id: "a", action: "waitForSelector", selector: "#ws-result:has-text('closed')" },
      ]),
    );
    expect(meta.results.map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(meta.logs).toEqual(expect.arrayContaining([expect.stringContaining("Blocked request to ws://169.254.169.254/socket")]));

    const loopback = `ws://127.0.0.1:${fixtures.port}/socket`;
    const priv = await privateRun([
      { id: "o", action: "goto", url: `/websocket.html?to=${encodeURIComponent(loopback)}` },
      { id: "a", action: "waitForSelector", selector: "#ws-result:has-text('closed')" },
    ]);
    expect(priv.logs).toEqual(expect.arrayContaining([expect.stringContaining(`Blocked request to ${loopback}`)]));

    // Setting off: the socket goes through to the server (which doesn't speak WebSocket) and isn't logged as blocked.
    const open = await execute(
      makePlan(fixtures.url, [
        { id: "o", action: "goto", url: `/websocket.html?to=${encodeURIComponent(loopback)}` },
        { id: "a", action: "waitForSelector", selector: "#ws-result:has-text('closed')" },
      ]),
    );
    expect(open.logs.filter((l) => l.includes("Blocked"))).toEqual([]);
  });

  it("refuses non-http schemes for navigation", async () => {
    const { results } = await execute(makePlan(fixtures.url, ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi"].map((url, i) => ({ ...goto(url, `n${i}`), optional: true }))));
    expect(results.map((r) => [r.status, r.errorCode])).toEqual(Array(3).fill(["skipped", "invalid_step"]));
  });
});
