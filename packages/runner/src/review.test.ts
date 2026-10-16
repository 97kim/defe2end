// Regression cases for the edge rules in docs/action-spec.md (section 5 items 23-24): selectors, select, variables, iframes and DOM checks.
import type { Step } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import { execute, makePlan, useFixtures } from "./test-support.js";

const server = useFixtures();
const open: Step = { id: "open", action: "goto", url: "/review.html" };
const run = (steps: Step[], extra = {}) => execute(makePlan(server.url, [open, ...steps], { stepTimeoutMs: 2000, ...extra }));
const title = (expected: string, id = "t"): Step => ({ id, action: "assertTitle", expected, timeout: 2000 });

describe("review regressions", () => {
  it("role chains match every named part exactly; unnamed parts by role only", async () => {
    const { results } = await run([
      { id: "a", action: "click", selector: "region(Cart) >> button(Buy)" },
      title("right-region", "t1"),
      { id: "b", action: "click", selector: "region(Cart) >> checkbox" },
      title("right-check", "t2"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
  });

  it("empty parentheses mean no name, so the exact variant doesn't pick the unnamed button", async () => {
    const { results } = await run([{ id: "a", action: "click", selector: "region(Pair) >> button()" }, title("pair-named")]);
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("select re-reads the options on every check instead of pinning an index found while disabled", async () => {
    const { results } = await run([{ id: "a", action: "click", selector: "#arm" }, { id: "s", action: "select", selector: "#shift", value: "want", timeout: 3000 }, title("shift-want")]);
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "passed"]);
  });

  it("a selector that substitutes to an empty string means no selector", async () => {
    const variables = { E: { value: "", secret: false } };
    const { results } = await run(
      [
        { id: "c", action: "click", selector: "{{E}}" },
        { id: "f", action: "click", selector: "#keys" },
        { id: "k", action: "pressKey", selector: "{{E}}", value: "k" },
        title("key-k", "t1"),
        { id: "s", action: "scroll", selector: "{{E}}", value: "bottom" },
        { id: "j", action: "assertJsonLd", selector: "{{E}}", expected: "@type=Product" },
        { id: "h", action: "hover", selector: "{{E}}", optional: true, timeout: 300 },
        { id: "v", action: "assertVisible", selector: "{{E}}", optional: true, timeout: 300 },
      ],
      { variables },
    );
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "passed", "passed", "passed", "passed", "skipped", "skipped"]);
  });

  it("select waits for a late option and takes the first match in document order", async () => {
    const { results } = await run([{ id: "s", action: "select", selector: "#late", value: "Big Box", timeout: 3500 }, title("picked-x")]);
    expect(results[1]).toMatchObject({ status: "passed", attempts: 1 });
    expect(results[2]!.status).toBe("passed");
  });

  it("assertResponse only sees the first page, not popups", async () => {
    const { results } = await run([
      { id: "c", action: "clickAndWaitPopup", selector: "#resp" },
      { id: "r", action: "assertResponse", expected: "tag=resp", value: "201", timeout: 6000 },
    ]);
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed"]);
    // The popup's 500 for the same pattern comes first; it must not fail the first try.
    expect(results[2]).toMatchObject({ attempts: 1 });
  });

  it("assertJsonLd keeps spaces around the operator, never matches null, and stringifies numbers and booleans", async () => {
    const steps: Step[] = [
      { id: "1", action: "assertJsonLd", expected: "price=1" },
      { id: "2", action: "assertJsonLd", expected: "big=1e+21" },
      { id: "3", action: "assertJsonLd", expected: "flag=true" },
      { id: "4", action: "assertJsonLd", expected: "@type = Product", optional: true, timeout: 300 },
      { id: "5", action: "assertJsonLd", expected: "name=null", optional: true, timeout: 300 },
      { id: "6", action: "assertJsonLd", expected: "big=1e21", optional: true, timeout: 300 },
      { id: "7", action: "assertJsonLd", expected: "tiny=1e-7" },
    ];
    const { results } = await run(steps);
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "passed", "skipped", "skipped", "skipped", "passed"]);
  });

  it("clickFirstEnabled takes a plain selector and the condition piece rules", async () => {
    const roleSyntax = await run([{ id: "c", action: "clickFirstEnabled", selector: "button(Go)", optional: true }]);
    expect(roleSyntax.results[1]).toMatchObject({ status: "skipped", errorCode: "invalid_step" });
    const noColon = await run([{ id: "c", action: "clickFirstEnabled", selector: ".cfe", expected: "blue", optional: true }]);
    expect(noColon.results[1]!.status).toBe("skipped");
    expect(noColon.results[1]!.errorMessage).toContain("No enabled element found");
    const emptyPiece = await run([{ id: "c", action: "clickFirstEnabled", selector: ".cfe", expected: "color:red|" }, title("cfe-blue")]);
    expect(emptyPiece.results.map((r) => r.status)).toEqual(["passed", "passed", "passed"]);
    const hex = await run([{ id: "c", action: "clickFirstEnabled", selector: ".cfe", expected: "color:#0000ff" }, title("cfe-blue")]);
    expect(hex.results.map((r) => r.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("uploadFile uses a single hidden input, else the first visible one", async () => {
    const file = `${server.url}/style.css`;
    const { results } = await run([
      { id: "u1", action: "uploadFile", selector: "#hidden-file", value: file },
      title("hidden-1", "t1"),
      { id: "u2", action: "uploadFile", selector: "input.multi", value: file },
      title("multi-visible", "t2"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
  });

  it("substitutes digit-first and empty variables, never prototype names", async () => {
    const variables = { "1PAGE": { value: "/review.html", secret: false }, E: { value: "", secret: false } };
    const { results } = await execute(
      makePlan(
        server.url,
        [
          { id: "open", action: "goto", url: "{{1PAGE}}" },
          { id: "l", action: "assertText", selector: "#literal", expected: "{{constructor}}" },
          { id: "u", action: "assertUrl", expected: "{{E}}" },
          { id: "w", action: "waitForUrl", expected: "{{E}}" },
          { id: "t", action: "assertTitle", expected: "{{E}}" },
          { id: "p", action: "clickAndSubmitPrompt", selector: "#prompt", value: "{{E}}" },
          title("prompt[]"),
          { id: "f", action: "uploadFile", selector: "#hidden-file", value: "{{E}}" },
        ],
        { stepTimeoutMs: 2000, variables },
      ),
    );
    expect(results.filter((r) => r.status !== "passed")).toEqual([]);
    expect(results).toHaveLength(8);
  });
  it("select is Playwright's selectOption: actionability, label retargeting and label normalization", async () => {
    const go: Step = { id: "o", action: "goto", url: "/review-select.html" };
    const sel = (id: string, selector: string, value: string, extra: Partial<Step> = {}): Step => ({ id, action: "select", selector, value, timeout: 800, ...extra });
    const failing = await execute(
      makePlan(server.url, [
        go,
        ...[sel("aria", "#aria", "b"), sel("group", "#group", "g"), sel("zero", "#zero", "b"), sel("hidden", "#hidden", "b"), sel("stuck", "#stuck", "w")].map((s) => ({ ...s, optional: true })),
      ], { stepTimeoutMs: 2000 }),
    );
    expect(failing.results.map((r) => r.status)).toEqual(["passed", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    const passing = await execute(
      makePlan(server.url, [
        go,
        sel("l", "#label-child", "b"),
        title("labelled-b", "t1"),
        sel("n", "#norm", "Red Apple"),
        title("norm-r", "t2"),
        sel("w", "#later", "w", { timeout: 3000 }),
        title("later-w", "t3"),
      ], { stepTimeoutMs: 2000 }),
    );
    expect(passing.results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "passed", "passed", "passed", "passed"]);
  });

  it("assertVisibleOrWarn with a selector that substitutes to empty warns", async () => {
    const { results } = await run([{ id: "w", action: "assertVisibleOrWarn", selector: "{{E}}", timeout: 300 }], { variables: { E: { value: "", secret: false } } });
    expect(results[1]).toMatchObject({ status: "warning", errorMessage: expect.stringContaining("Element not found (warning)") });
  });

  it("iframe actions with an empty iframe path time out and fail, even with one iframe on the page", async () => {
    const variables = { E: { value: "", secret: false } };
    for (const step of [
      { id: "v", action: "assertVisibleInIframe", selector: "{{E}}", value: "button", timeout: 400 },
      { id: "f", action: "fillInIframe", selector: "{{E}}", value: "#f", expected: "x", timeout: 400 },
      { id: "c", action: "clickInIframe", selector: "{{E}}", value: "button", timeout: 400 },
    ] as const) {
      const { results } = await execute(makePlan(server.url, [{ id: "o", action: "goto", url: "/review-frame.html" }, step], { stepTimeoutMs: 2000, variables }));
      expect(results[1], step.action).toMatchObject({ status: "failed", errorCode: "timeout" });
    }
  });

  it("assertResponse reads a status variable with JavaScript number conversion", async () => {
    const cases: [string, string][] = [["2e2", "passed"], ["200.0", "passed"], ["0xC8", "passed"], ["", "passed"], ["  ", "skipped"], ["abc", "skipped"]];
    const variables = Object.fromEntries(cases.map(([v], i) => [`S${i}`, { value: v, secret: false }]));
    const steps: Step[] = [{ id: "o", action: "goto", url: "/review-select.html" }];
    cases.forEach(([, want], i) => {
      steps.push({ id: `c${i}`, action: "click", selector: "#ok200" });
      steps.push({ id: `r${i}`, action: "assertResponse", expected: "tag=num", value: `{{S${i}}}`, timeout: 2000, optional: want === "skipped" });
    });
    const { results } = await execute(makePlan(server.url, steps, { stepTimeoutMs: 3000, variables }));
    expect(results.filter((r) => r.stepId.startsWith("r")).map((r) => r.status)).toEqual(cases.map(([, want]) => want));
  });
});

