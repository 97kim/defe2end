// Screenshots mask secret fields or are not collected, trace only on failure and never with secrets, video
// only when asked.
import type { Step } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import { boxOf, execute, makePlan, pixelAt, SECRET, useFixtures } from "./test-support.js";

const fixtures = useFixtures();
const open: Step = { id: "open", action: "goto", url: "/actions.html" };
const failing: Step = { id: "fail", action: "assertText", selector: "#title", expected: "nope", timeout: 300 };
const MAGENTA = [255, 0, 255];
// A run with masking on records no trace (stage 7 contract section 5); these cases are about the other rules.
const MASKING_OFF = { masking: { enabled: false, selectors: [], policyVersion: 1 } };

describe("screenshots", () => {
  it("masks a secret typed into a field inside an iframe", async () => {
    const { files, verdict } = await execute(
      makePlan(
        fixtures.url,
        [
          open,
          { id: "f", action: "fillInIframe", selector: "iframe#frame", value: "#frame-input", expected: "{{TOKEN}}" },
          // Auto-scroll moved the page to the field; back to where boxOf measures it.
          { id: "top", action: "scroll", value: "top" },
          { id: "s", action: "screenshot", name: "framed" },
        ],
        { variables: { TOKEN: { value: SECRET, secret: true } } },
      ),
    );
    expect(verdict.status).toBe("passed");
    // Measured after the page's timed changes (#delayed, #spinner, #later) that shift the frame, as in the run.
    const box = await boxOf(`${fixtures.url}/actions.html`, "#frame-input", "#frame", 1_500);
    expect(await pixelAt(files[0]!.bytes, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2))).toEqual(MAGENTA);
  });

  it("records 'not collected' instead of an unmasked image when a secret can't be pointed at", async () => {
    const { files, logs, results } = await execute(
      makePlan(fixtures.url, [
        open,
        { id: "focus", action: "click", selector: "#keys" },
        { id: "type", action: "pressKey", value: "{{KEY}}" },
        { id: "shot", action: "screenshot", name: "after typing" },
        failing,
      ], { variables: { KEY: { value: "Q", secret: true } } }),
    );
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "passed", "failed"]);
    expect(files.filter((f) => f.kind === "screenshot")).toEqual([]);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Screenshot "after typing" not collected: a secret was typed without a target field$/),
        expect.stringMatching(/^Screenshot "step-5-failure" not collected/),
      ]),
    );
  });

  it("masks a secret field that renamed itself after typing, in a screenshot step and a failure screenshot", async () => {
    const { files, logs, results } = await execute(
      makePlan(fixtures.url, [
        { id: "open", action: "goto", url: "/rename.html" },
        { id: "f", action: "fill", selector: "#token", value: "{{TOKEN}}" },
        { id: "s", action: "screenshot", name: "renamed" },
        failing,
      ], { variables: { TOKEN: { value: SECRET, secret: true } } }),
    );
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "failed"]);
    const shots = files.filter((f) => f.kind === "screenshot");
    expect(shots.map((f) => f.name)).toEqual(["renamed", "step-4-failure"]);
    const box = await boxOf(`${fixtures.url}/rename.html`, "#token");
    for (const shot of shots) {
      expect(await pixelAt(shot.bytes, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)), shot.name).toEqual(MAGENTA);
    }
    expect(logs.filter((l) => l.includes("not collected"))).toEqual([]);
  });

  it("records 'not collected' when a secret field can no longer be found for masking", async () => {
    const { files, logs, results } = await execute(
      makePlan(fixtures.url, [
        { id: "open", action: "goto", url: "/rename.html" },
        { id: "f", action: "fill", selector: "#sealed", value: "{{TOKEN}}" },
        { id: "s", action: "screenshot", name: "sealed" },
        failing,
      ], { variables: { TOKEN: { value: SECRET, secret: true } } }),
    );
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "failed"]);
    expect(files.filter((f) => f.kind === "screenshot")).toEqual([]);
    expect(logs).toEqual(
      expect.arrayContaining([
        'Screenshot "sealed" not collected: a field holding a secret could not be located for masking',
        'Screenshot "step-4-failure" not collected: a field holding a secret could not be located for masking',
      ]),
    );
  });

  it("checks every secret field on its own: one field that can't be found stops the screenshot", async () => {
    const both = await execute(
      makePlan(fixtures.url, [
        { id: "open", action: "goto", url: "/rename.html" },
        { id: "f1", action: "fill", selector: "#token", value: "{{TOKEN}}" },
        { id: "f2", action: "fill", selector: "#sealed", value: "{{TOKEN}}" },
        { id: "s", action: "screenshot", name: "both" },
      ], { variables: { TOKEN: { value: SECRET, secret: true } } }),
    );
    expect(both.files.filter((f) => f.kind === "screenshot")).toEqual([]);
    expect(both.logs).toContain('Screenshot "both" not collected: a field holding a secret could not be located for masking');

    const two = await execute(
      makePlan(fixtures.url, [
        { id: "open", action: "goto", url: "/rename.html" },
        { id: "f1", action: "fill", selector: "#token", value: "{{TOKEN}}" },
        { id: "f2", action: "fill", selector: "#token2", value: "{{TOKEN}}" },
        { id: "again", action: "fill", selector: "#sealed", value: "plain" },
        { id: "s", action: "screenshot", name: "two" },
      ], { variables: { TOKEN: { value: SECRET, secret: true } } }),
    );
    const shots = two.files.filter((f) => f.kind === "screenshot");
    expect(shots.map((f) => f.name)).toEqual(["two"]);
    for (const selector of ["#token", "#token2"]) {
      const box = await boxOf(`${fixtures.url}/rename.html`, selector);
      expect(await pixelAt(shots[0]!.bytes, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)), selector).toEqual(MAGENTA);
    }
  });

  it("fails a popup action once the popup closed itself, and still captures the page in front", async () => {
    const { files, results } = await execute(
      makePlan(fixtures.url, [
        open,
        { id: "o", action: "clickAndWaitPopup", selector: "#popup-one" },
        { id: "close", action: "clickInPopup", selector: "#close" },
        // The popup closes itself just after the click returns, so the click step passes on slow machines too.
        { id: "settle", action: "wait", timeout: 1000 },
        { id: "x", action: "clickInPopup", selector: "h1", timeout: 300 },
      ]),
    );
    expect(results.slice(1, -1).map((r) => [r.stepId, r.status])).toEqual([["o", "passed"], ["close", "passed"], ["settle", "passed"]]);
    expect(results.at(-1)).toMatchObject({ status: "failed", errorCode: "no_popup", errorMessage: "No popup page available. Use clickAndWaitPopup first." });
    expect(files.filter((f) => f.kind === "screenshot").map((f) => f.name)).toEqual(["step-5-failure"]);
  });
});

describe("trace", () => {
  const plan = (steps: Step[], variables = {}) => makePlan(fixtures.url, steps, { variables, capture: { video: false, traceOnFailure: true } });

  it("is collected for a failed run and not for a passed one", async () => {
    const failed = await execute(plan([open, failing]), MASKING_OFF);
    const trace = failed.files.filter((f) => f.kind === "trace");
    expect(trace).toHaveLength(1);
    expect(trace[0]!.bytes.subarray(0, 2).toString()).toBe("PK");

    const passed = await execute(plan([open]), MASKING_OFF);
    expect(passed.files.filter((f) => f.kind === "trace")).toEqual([]);
  });

  it("is never collected when a step uses a secret variable, but an unused secret doesn't stop it", async () => {
    const secret = await execute(plan([open, { id: "f", action: "fill", selector: "#name", value: "{{TOKEN}}" }, failing], { TOKEN: { value: SECRET, secret: true } }), MASKING_OFF);
    expect(secret.verdict.status).toBe("failed");
    expect(secret.files.filter((f) => f.kind === "trace")).toEqual([]);
    expect(JSON.stringify(secret.events)).not.toContain(SECRET);

    const unused = await execute(plan([open, failing], { TOKEN: { value: SECRET, secret: true } }), MASKING_OFF);
    expect(unused.files.filter((f) => f.kind === "trace")).toHaveLength(1);
  });
});

describe("video", () => {
  it("is off unless the plan turns it on", async () => {
    const off = await execute(makePlan(fixtures.url, [open]));
    expect(off.files.filter((f) => f.kind === "video")).toEqual([]);

    const on = await execute(makePlan(fixtures.url, [open, { id: "c", action: "clickAndWaitPopup", selector: "#popup-one" }], { capture: { video: true, traceOnFailure: false } }));
    const videos = on.files.filter((f) => f.kind === "video");
    expect(videos.map((v) => v.name)).toEqual(["video-1", "video-2"]);
    // WebM (EBML) header.
    expect(videos[0]!.bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
    expect(on.logs).toContain("Video is on: it can't hide secrets or personal data");
  });
});
