// Actions against the fixture pages, passing and failing, plus the timing rules of assertResponse, the
// default dialog handling, the popup model and step retries (docs/action-spec.md).
import type { Step } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import { execute, makePlan, useFixtures } from "./test-support.js";

const fixtures = useFixtures();
const plan = (steps: Step[], extra = {}) => makePlan(fixtures.url, steps, extra);
const open = (path = "/actions.html"): Step => ({ id: "open", action: "goto", url: path });
/** Optional steps turn an action failure into `skipped` with its code, so one run reports each outcome. */
const optional = (steps: Step[], timeout = 600): Step[] => steps.map((s) => ({ timeout, optional: true, ...s }));

describe("actions that pass", () => {
  it("runs the actions against the fixture page", async () => {
    const steps: Step[] = [
      open(),
      { id: "t1", action: "assertText", selector: "#title", expected: "Action   fixtures" },
      { id: "h1", action: "hover", selector: "#hover-target" },
      { id: "h2", action: "assertVisible", selector: "#hover-tip" },
      { id: "c1", action: "click", selector: "#counter" },
      { id: "c2", action: "assertText", selector: "#counter", expected: "Clicked 1" },
      { id: "f1", action: "fill", selector: "#name", value: "abc" },
      { id: "f2", action: "assertText", selector: "#echo", expected: "abc" },
      { id: "s1", action: "select", selector: "#size", value: "Large" },
      { id: "s2", action: "assertText", selector: "#size-result", expected: "Large" },
      { id: "s3", action: "select", selector: "#size", value: "Medium" },
      { id: "s4", action: "assertText", selector: "#size-result", expected: "m" },
      { id: "p1", action: "pressKey", selector: "#keys", value: "Control+a" },
      { id: "p2", action: "assertText", selector: "#last-key", expected: "Control+a" },
      { id: "p3", action: "pressKey", value: "Enter" },
      { id: "p4", action: "assertText", selector: "#last-key", expected: "Enter" },
      { id: "u1", action: "uploadFile", selector: "#file", value: `${fixtures.url}/style.css` },
      { id: "u2", action: "assertText", selector: "#file-name", expected: "style.css:" },
      { id: "w1", action: "waitForSelector", selector: "#delayed" },
      { id: "w2", action: "wait", timeout: 100 },
      { id: "n1", action: "assertCount", selector: "#items li", expected: "3" },
      // Several matches no longer fail: the first visible element is used (spec 2.4).
      { id: "m1", action: "hover", selector: "li" },
      { id: "m2", action: "assertText", selector: "li", expected: "One" },
      { id: "r1", action: "scroll", selector: "#bottom" },
      { id: "r2", action: "scroll", value: "top" },
      { id: "r3", action: "scroll", value: "-50" },
      { id: "i1", action: "fillInIframe", selector: "iframe#frame", value: "#frame-input", expected: "framed" },
      { id: "i2", action: "assertVisibleInIframe", selector: "iframe#frame", value: "#frame-title" },
      { id: "i3", action: "clickInIframe", selector: "iframe#frame", value: "#frame-input" },
      { id: "x1", action: "screenshot", name: "page" },
      { id: "x2", action: "screenshot" },
      { id: "g1", action: "click", selector: "#go-cart" },
      { id: "g2", action: "waitForUrl", expected: "/cart.html" },
      { id: "g3", action: "assertUrl", expected: "/cart.html?from=actions#top" },
      // HTTP status is not looked at (spec 3.1 goto).
      { id: "g4", action: "goto", url: "/missing.html" },
    ];
    const { verdict, results, files } = await execute(plan(steps));
    expect(results.filter((r) => r.status !== "passed").map((r) => [r.stepId, r.errorCode, r.errorMessage])).toEqual([]);
    expect(verdict.status).toBe("passed");
    expect(files.map((f) => [f.kind, f.name])).toEqual([["screenshot", "page"], ["screenshot", "step-31"]]);
  });
});

describe("actions that fail", () => {
  it("fails each action with the right code, expected and actual", async () => {
    const steps = [
      open(),
      ...optional([
        { id: "click", action: "click", selector: "#nope" },
        { id: "fill", action: "fill", selector: "#nope", value: "x" },
        { id: "select", action: "select", selector: "#size", value: "Huge" },
        { id: "upload", action: "uploadFile", selector: "#file", value: `${fixtures.url}/missing.bin` },
        { id: "press", action: "pressKey", selector: "#nope", value: "Enter" },
        { id: "scroll", action: "scroll", selector: "#nope" },
        { id: "wait", action: "waitForSelector", selector: "#nope" },
        { id: "text", action: "assertText", selector: "#counter", expected: "Other" },
        { id: "textCase", action: "assertText", selector: "#title", expected: "action" },
        { id: "visible", action: "assertVisible", selector: "#hover-tip" },
        { id: "count", action: "assertCount", selector: "#items li", expected: "4" },
        { id: "url", action: "assertUrl", expected: "/nowhere" },
        { id: "inner", action: "clickInIframe", selector: "iframe#frame", value: "#nope" },
      ]),
    ];
    const { verdict, results } = await execute(plan(steps));
    // Optional failures don't change the verdict (spec 2.9).
    expect(verdict.status).toBe("passed");
    const by = Object.fromEntries(results.map((r) => [r.stepId, r]));
    expect(Object.fromEntries(results.slice(1).map((r) => [r.stepId, [r.status, r.errorCode]]))).toEqual({
      click: ["skipped", "timeout"],
      fill: ["skipped", "timeout"],
      select: ["skipped", "timeout"],
      upload: ["skipped", "download_failed"],
      press: ["skipped", "timeout"],
      scroll: ["skipped", "timeout"],
      wait: ["skipped", "timeout"],
      text: ["skipped", "assertion_failed"],
      textCase: ["skipped", "assertion_failed"],
      visible: ["skipped", "timeout"],
      count: ["skipped", "assertion_failed"],
      url: ["skipped", "assertion_failed"],
      inner: ["skipped", "timeout"],
    });
    expect(by.text).toMatchObject({ expected: "Other", actual: "Clicked 0" });
    expect(by.count).toMatchObject({ expected: "4", actual: "3" });
    expect(by.upload!.errorMessage).toContain("could not download file (HTTP 404)");
    expect(results.slice(1).every((r) => r.attempts === 1 && r.errorMessage!.startsWith("[optional] "))).toBe(true);
  });
});

describe("assertResponse", () => {
  it("judges the first matching response after the step starts, exactly against the status", async () => {
    const { results } = await execute(
      plan([
        open(),
        { id: "late", action: "click", selector: "#fetch-late" },
        { id: "check", action: "assertResponse", expected: "/api/status", value: "500", timeout: 3_000 },
        { id: "late2", action: "click", selector: "#fetch-late" },
        // Optional, so no retry: the judgement is on the first response, not one that comes later.
        { id: "first", action: "assertResponse", expected: "/api/status", timeout: 3_000, optional: true },
      ]),
    );
    expect(results.map((r) => [r.stepId, r.status, r.errorCode])).toEqual([
      ["open", "passed", undefined],
      ["late", "passed", undefined],
      ["check", "passed", undefined],
      ["late2", "passed", undefined],
      ["first", "skipped", "assertion_failed"],
    ]);
    expect(results[4]).toMatchObject({ expected: "200", actual: "500" });
  });

  it("ignores responses from before the step and fails when none comes", async () => {
    const { results } = await execute(
      plan([open(), { id: "early", action: "click", selector: "#fetch-before" }, { id: "check", action: "assertResponse", expected: "/api/status", value: "204", timeout: 500 }]),
    );
    expect(results[2]).toMatchObject({ status: "failed", errorCode: "timeout", actual: "no response" });
  });
});

describe("dialogs without a dialog action", () => {
  it("accepts a dialog on the first page and the step passes", async () => {
    const { results } = await execute(
      plan([
        open(),
        { id: "c", action: "click", selector: "#confirm" },
        { id: "a", action: "assertText", selector: "#dialog-result", expected: "confirmed" },
        { id: "p", action: "click", selector: "#prompt" },
        { id: "s", action: "goto", url: "/unexpected-dialog.html" },
        { id: "u", action: "click", selector: "#surprise" },
      ]),
    );
    expect(results.filter((r) => r.status !== "passed")).toEqual([]);
  });
});

describe("new windows", () => {
  it("takes the first page opened during clickAndWaitPopup; other actions stay on the first page", async () => {
    const { results } = await execute(
      plan([
        open(),
        { id: "o", action: "clickAndWaitPopup", selector: "#popup-one" },
        { id: "a", action: "assertVisibleInPopup", selector: "#popup-title" },
        { id: "m", action: "assertText", selector: "#title", expected: "Action" },
        { id: "two", action: "clickAndWaitPopup", selector: "#popup-two" },
        { id: "u", action: "assertPopupUrl", expected: "popup.html?n=" },
        { id: "c", action: "closePopup" },
      ]),
    );
    expect(results.filter((r) => r.status !== "passed")).toEqual([]);
  });

  it("only clickAndWaitPopup sets the current new window", async () => {
    const { results } = await execute(
      plan([
        open(),
        { id: "link", action: "click", selector: "#popup-link" },
        { id: "settle", action: "wait", timeout: 300 },
        { id: "url", action: "assertPopupUrl", expected: "popup", optional: true },
        { id: "none", action: "clickAndWaitPopup", selector: "#counter", timeout: 500 },
      ]),
    );
    expect(results.map((r) => [r.stepId, r.status, r.errorCode])).toEqual([
      ["open", "passed", undefined],
      ["link", "passed", undefined],
      ["settle", "passed", undefined],
      ["url", "skipped", "no_popup"],
      ["none", "failed", "timeout"],
    ]);
  });
});

describe("retries", () => {
  it("retries a failed step once after a pause", async () => {
    const { results } = await execute(
      plan([
        open(),
        // #later shows after 1300 ms: the first 250 ms attempt times out, the retry a second later clicks it.
        { id: "late", action: "click", selector: "#later", timeout: 250 },
        { id: "never", action: "click", selector: "#nope", timeout: 200 },
      ]),
    );
    expect(results.map((r) => [r.stepId, r.status, r.attempts, r.retried])).toEqual([
      ["open", "passed", 1, undefined],
      ["late", "passed", 2, true],
      ["never", "failed", 2, true],
    ]);
  });

  it("does not retry a step stopped from outside", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort("cancelled"), 1_500);
    const { results } = await execute(plan([open(), { id: "w", action: "waitForSelector", selector: "#nope", timeout: 60_000 }]), { signal: controller.signal });
    expect(results[1]).toMatchObject({ status: "cancelled", attempts: 1 });
  });
});
