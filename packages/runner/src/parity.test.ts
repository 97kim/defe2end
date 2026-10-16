// Spec actions against the parity fixture page: pass, fail and warning per action, multi-match and retry timing.
import type { Step } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import { execute, makePlan, useFixtures } from "./test-support.js";

const server = useFixtures();
const open: Step = { id: "open", action: "goto", url: "/parity.html" };
const run = (steps: Step[], extra = {}) => execute(makePlan(server.url, [open, ...steps], { stepTimeoutMs: 2000, ...extra }));
const title = (expected: string, id = "t"): Step => ({ id, action: "assertTitle", expected, timeout: 2000 });

describe("spec actions", () => {
  it("role syntax prefers the exact name; multi-match falls back to the first visible element", async () => {
    const { verdict, results } = await run([
      { id: "a", action: "click", selector: "button(add)" },
      title("clicked-add", "t1"),
      { id: "b", action: "click", selector: ".dup" },
      title("dup-visible", "t2"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
    expect(verdict).toMatchObject({ status: "passed", warningCount: 0 });
  });

  it("checks text, url, title, count, exists and json-ld", async () => {
    const { verdict, results } = await run([
      { id: "1", action: "assertText", selector: "#text", expected: "Hello   World" },
      { id: "2", action: "assertUrl", expected: "/parity*.html" },
      { id: "3", action: "assertTitle", expected: "Parity*" },
      { id: "4", action: "assertCount", selector: ".cfe", expected: "3" },
      { id: "5", action: "assertExists", selector: "meta[name=description]" },
      { id: "6", action: "assertJsonLd", expected: "offers[*].price=10" },
      { id: "7", action: "assertJsonLd", expected: "@type=Product" },
      { id: "8", action: "waitForUrl", expected: "/parity.{htm,html}" },
      { id: "9", action: "scroll", value: "bottom" },
      { id: "10", action: "wait", timeout: 10 },
    ]);
    expect(results.filter((r) => r.status !== "passed")).toEqual([]);
    expect(verdict.status).toBe("passed");
  });

  it("fails a text check case-sensitively and a json-ld miss, without retrying past one extra try", async () => {
    const { results } = await run([{ id: "x", action: "assertText", selector: "#text", expected: "hello" }]);
    expect(results[1]).toMatchObject({ status: "failed", errorCode: "assertion_failed", attempts: 2, retried: true });
    const jsonLd = await run([{ id: "j", action: "assertJsonLd", expected: "@type=Event", timeout: 300 }]);
    expect(jsonLd.results[1]!.errorMessage).toContain("Product");
  });

  it("warns, skips optional failures, and keeps the run passed", async () => {
    const started = Date.now();
    const { verdict, results } = await run([
      { id: "w", action: "assertVisibleOrWarn", selector: "#missing", timeout: 200 },
      { id: "o", action: "click", selector: "#missing", optional: true, timeout: 200 },
      { id: "c", action: "clickFirstEnabled", selector: ".cfe", expected: "background-color:#000000" },
      title("cfe-3"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["passed", "warning", "skipped", "passed", "passed"]);
    expect(results[1]!.errorMessage).toBe("Element not found (warning): #missing");
    expect(results[2]).toMatchObject({ attempts: 1 });
    expect(results[2]!.errorMessage).toMatch(/^\[optional\] /);
    expect(verdict).toMatchObject({ status: "passed", warningCount: 1 });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("retries a failed step once after about one second", async () => {
    const { results } = await run([{ id: "r", action: "click", selector: "#missing", timeout: 100 }]);
    expect(results[1]).toMatchObject({ status: "failed", attempts: 2, retried: true });
    expect(results[1]!.durationMs).toBeGreaterThanOrEqual(1000);
  });

  it("handles dialogs: accept with message check, dismiss, prompt, and missing dialog", async () => {
    const { results } = await run([
      { id: "1", action: "clickAndAcceptDialog", selector: "#confirm", expected: "Sure" },
      title("yes", "t1"),
      { id: "2", action: "clickAndDismissDialog", selector: "#confirm" },
      title("no", "t2"),
      { id: "3", action: "clickAndSubmitPrompt", selector: "#prompt", value: "Kim" },
      title("hi Kim", "t3"),
      { id: "4", action: "click", selector: "#alert" },
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(8).fill("passed"));
    const alert = await run([{ id: "a", action: "clickAndDismissDialog", selector: "#alert", timeout: 500 }]);
    expect(alert.results[1]!.errorMessage).toContain("alert can't be dismissed");
    const none = await run([{ id: "n", action: "clickAndAcceptDialog", selector: "#nodialog", timeout: 300 }]);
    expect(none.results[1]!.errorMessage).toBe("dialog did not appear");
  });

  it("popup actions use the current new window; without one they fail", async () => {
    const before = await run([{ id: "p", action: "assertPopupUrl", expected: "x" }]);
    expect(before.results[1]!.errorMessage).toBe("No popup page available. Use clickAndWaitPopup first.");
    const { results } = await run([
      { id: "1", action: "clickAndWaitPopup", selector: "#pop" },
      { id: "2", action: "assertPopupUrl", expected: "popup=1" },
      { id: "3", action: "assertVisibleInPopup", selector: "#text" },
      { id: "4", action: "closePopup" },
      { id: "5", action: "closePopup" },
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(6).fill("passed"));
  });

  it("iframe actions follow >>> paths and stay strict on several matches", async () => {
    const { results } = await run([{ id: "1", action: "clickInIframe", selector: "iframe#outer >>> iframe#inner", value: "text=Deep" }]);
    expect(results[1]!.status).toBe("passed");
    const strict = await run([{ id: "2", action: "clickInIframe", selector: "iframe#outer >>> iframe#inner", value: ".two", timeout: 300 }]);
    expect(strict.results[1]!.status).toBe("failed");
  });

  it("uploads files downloaded from URLs and rejects HTTP errors", async () => {
    const { results } = await run([
      { id: "u", action: "uploadFile", selector: "#file", value: `${server.url}/style.css ${server.url}/index.html` },
      title("style.css:text/css,index.html:text/html"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed"]);
    const missing = await run([{ id: "m", action: "uploadFile", selector: "#file", value: `${server.url}/nope.png` }]);
    expect(missing.results[1]!.errorMessage).toContain("could not download file (HTTP 404)");
  });

  it("leaves undefined variables literal", async () => {
    const { results } = await run([{ id: "v", action: "assertUrl", expected: "{{NOPE}}", timeout: 100 }]);
    expect(results[1]!.errorMessage).toContain("{{NOPE}}");
  });
});
