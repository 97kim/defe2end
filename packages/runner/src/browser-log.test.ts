import { STEP_LOG_MAX_BYTES } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import { BROWSER_LOG_LINE_CHARS, BROWSER_LOG_STEP_LINES, BrowserLog } from "./browser-log.js";
import { runPlan } from "./index.js";
import { makePlan, memorySink, SANDBOX, SECRET, useFixtures } from "./test-support.js";

const fixtures = useFixtures();

describe("BrowserLog", () => {
  it("masks secrets before personal data and query values, and cuts long lines after masking", () => {
    const log = new BrowserLog([SECRET], { lineChars: 40, stepLines: 10, runLines: 10 });
    log.add(0, `token ${SECRET} for kim@example.com`);
    log.add(0, "see https://shop.test/a?q=1&id=2");
    log.add(0, "y".repeat(100));
    const text = log.take(0)!;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("[email]");
    expect(text).not.toContain("q=1");
    expect(text).toContain(`${"y".repeat(40)}…`);
    expect(log.take(0)).toBeNull();
  });

  it("keeps per-step and per-run limits and says how many lines were left out", () => {
    const log = new BrowserLog([], { lineChars: 100, stepLines: 2, runLines: 3 });
    for (let i = 0; i < 5; i++) log.add(0, `a${i}`);
    for (let i = 0; i < 4; i++) log.add(1, `b${i}`);
    expect(log.take(0)).toBe("a0\na1\n… 3 more browser log lines omitted\n");
    expect(log.take(1)).toBe("b0\n… 3 more browser log lines omitted\n");
  });
});

describe("browser log artifacts", () => {
  const run = async (burst: number) => {
    const { sink, files } = memorySink();
    const plan = makePlan(fixtures.url, [
      { id: "open", action: "goto", url: `/console.html?token={{TOKEN}}&burst=${burst}` },
      { id: "burst", action: "click", selector: "#burst" },
      { id: "popup", action: "click", selector: "#open" },
      { id: "wait", action: "wait", timeout: 1_000 },
      { id: "fail", action: "assertVisible", selector: "#missing", timeout: 500 },
    ], { variables: { TOKEN: { value: SECRET, secret: true } } });
    const verdict = await runPlan(plan, { sink, signal: new AbortController().signal, owner: String(process.pid), sandbox: SANDBOX, onEvent: () => {} });
    const logs = files.filter((f) => f.kind === "log");
    return { verdict, logs, byStep: new Map(logs.map((f) => [f.stepIndex, f.bytes.toString("utf8")])) };
  };

  it("collects console errors, page errors and failed requests of every page per step, masked", async () => {
    const { verdict, logs, byStep } = await run(0);
    expect(verdict.status).toBe("failed");
    for (const f of logs) expect(f.name).toBe(`step-${f.stepIndex! + 1}-console`);
    const first = byStep.get(0)!;
    expect(first).toContain("console.error: Login failed (page) for [email] with token");
    expect(first).toContain("console.warning: Deprecated call (page)");
    expect(first).not.toContain("plain log");
    expect(first).toMatch(/response 404: GET http:\/\/[^ ]+\/missing-page\.json\?token=•+/);
    expect(first).toContain("page error: Uncaught boom (page)");
    const all = [...byStep.values()].join("\n");
    expect(all).toContain("Login failed (popup)");
    expect(all).toContain("missing-popup.json");
    for (const leaked of [SECRET, "kim@example.com", encodeURIComponent(SECRET)]) expect(all).not.toContain(leaked);
  });

  it("caps a noisy step and notes what was left out", async () => {
    const { byStep } = await run(BROWSER_LOG_STEP_LINES + 10);
    const lines = byStep.get(1)!.trimEnd().split("\n");
    expect(Buffer.byteLength(byStep.get(1)!)).toBeLessThanOrEqual(STEP_LOG_MAX_BYTES);
    expect(lines).toHaveLength(BROWSER_LOG_STEP_LINES + 1);
    expect(lines.at(-1)).toBe("… 10 more browser log lines omitted");
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(BROWSER_LOG_LINE_CHARS + 1);
  });
});
