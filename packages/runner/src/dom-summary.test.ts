import { DOM_SUMMARY_MAX_BYTES } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import { launchBrowser } from "./browser.js";
import { clipUtf8, domSummary } from "./dom-summary.js";
import { runPlan } from "./index.js";
import { makePlan, memorySink, SANDBOX, SECRET, useFixtures } from "./test-support.js";

const fixtures = useFixtures();

describe("domSummary", () => {
  it("keeps structure and drops values, data-* attributes, sensitive fields, secrets and personal data", async () => {
    const running = await launchBrowser({ owner: String(process.pid), runId: "dom-summary", sandbox: SANDBOX, hostRules: "" });
    try {
      const page = await running.browser.newPage();
      // A real origin, so links resolve against it.
      await page.goto(`${fixtures.url}/index.html`);
      await page.setContent(`<title>Checkout</title>
        <main><h1>Pay now</h1>
        <p>Contact help@shop.test or +82 10-1234-5678. Token: ${SECRET}</p>
        <a href="/orders?id=42&email=a@b.test">Orders</a>
        <form action="/pay?session=abc"><label for="who">Name</label>
          <input id="who" name="who" data-user-id="u-777" value="typed-name">
          <input type="password" name="pw" value="pw-value-123">
          <input name="card" autocomplete="cc-number" value="4111111111111111">
          <textarea name="note">note-text-value</textarea>
          <button type="submit" data-track="t-999">Pay</button></form></main>`);
      await page.fill("#who", "filled-later");
      const summary = await domSummary(page, "#who", [SECRET]);
      expect(summary).toContain("# Checkout");
      expect(summary).toContain('"Pay now"');
      expect(summary).toContain("target: <input id=who name=who> \"Name\"");
      expect(summary).toContain("href=/orders");
      expect(summary).toContain("[sensitive field]");
      for (const leaked of ["typed-name", "filled-later", "pw-value-123", "4111111111111111", "note-text-value", "u-777", "t-999", SECRET, "help@shop.test", "1234-5678", "id=42", "session=abc"]) {
        expect(summary).not.toContain(leaked);
      }
    } finally {
      await running.close();
    }
  });

  it("masks e-mail, phone numbers and URL queries in page text, and keeps dates and versions", async () => {
    const running = await launchBrowser({ owner: String(process.pid), runId: "dom-summary-text", sandbox: SANDBOX, hostRules: "" });
    try {
      const page = await running.browser.newPage();
      await page.setContent("<h1>mail a.b+c@shop.co.kr</h1><h2>call 010-1234-5678</h2><h3>see https://x.test/p?q=1#h</h3><h3>version 1.2.3 on 2026-10-15</h3>");
      const summary = await domSummary(page, null, []);
      expect(summary).toContain('"mail [email]"');
      expect(summary).toContain('"call [phone]"');
      expect(summary).toContain('"see https://x.test/p?q=••••••#h"');
      expect(summary).toContain('"version 1.2.3 on 2026-10-15"');
    } finally {
      await running.close();
    }
  });

  it("masks a long secret whole before shortening the text around it", async () => {
    const longSecret = "s3cr3t-".repeat(12);
    const running = await launchBrowser({ owner: String(process.pid), runId: "dom-summary-long", sandbox: SANDBOX, hostRules: "" });
    try {
      const page = await running.browser.newPage();
      await page.setContent(`<h1>${longSecret}</h1><h2 aria-label="${"x".repeat(100)}">t</h2>`);
      const summary = await domSummary(page, null, [longSecret]);
      expect(summary).not.toContain(longSecret.slice(0, 20));
      expect(summary).toContain('"••••••"');
      expect(summary).toContain(`"${"x".repeat(60)}…"`);
    } finally {
      await running.close();
    }
  });

  it("masks secrets longer than any cut and secrets with runs of whitespace", async () => {
    const huge = "h".repeat(3_000);
    const spaced = "pass  word\twith   gaps";
    const running = await launchBrowser({ owner: String(process.pid), runId: "dom-summary-raw", sandbox: SANDBOX, hostRules: "" });
    try {
      const page = await running.browser.newPage();
      await page.setContent(`<h1>${huge}</h1><h2>${spaced}</h2>`);
      await page.evaluate((v) => {
        document.querySelector("h2")!.textContent = v;
      }, spaced);
      const summary = await domSummary(page, null, [huge, spaced]);
      expect(summary).not.toContain("hhhhhhhhhh");
      expect(summary).not.toContain("pass word");
      expect(summary).not.toContain("gaps");
    } finally {
      await running.close();
    }
  });

  it("stays within 8KB without splitting a character", () => {
    const clipped = clipUtf8("가".repeat(5_000));
    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(DOM_SUMMARY_MAX_BYTES);
    expect(clipped).toMatch(/가\n… \(cut\)$/);
    expect(clipUtf8("short")).toBe("short");
  });
});

describe("dom_summary artifact", () => {
  const run = async (selector: string) => {
    const { sink, files } = memorySink();
    const plan = makePlan(fixtures.url, [
      { id: "open", action: "goto", url: "/login.html" },
      { id: "user", action: "fill", selector: "[data-testid=username]", value: "{{USER}}" },
      { id: "check", action: "assertVisible", selector, timeout: 500 },
    ], { variables: { USER: { value: SECRET, secret: true } } });
    const verdict = await runPlan(plan, { sink, signal: new AbortController().signal, owner: String(process.pid), sandbox: SANDBOX, onEvent: () => {} });
    return { verdict, summaries: files.filter((f) => f.kind === "dom_summary") };
  };

  it("is stored for a failed step, masked, even in a run with secrets", async () => {
    const { verdict, summaries } = await run("#missing");
    expect(verdict.status).toBe("failed");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ stepIndex: 2, name: "step-3-dom" });
    const text = summaries[0]!.bytes.toString("utf8");
    expect(text).toContain("Failed selector: #missing");
    expect(text).toContain("# Log in");
    expect(text).not.toContain(SECRET);
    expect(summaries[0]!.bytes.length).toBeLessThanOrEqual(DOM_SUMMARY_MAX_BYTES);
  });

  it("is not made when the run passes", async () => {
    const { verdict, summaries } = await run("[data-testid=login-submit]");
    expect(verdict.status).toBe("passed");
    expect(summaries).toEqual([]);
  });
});
