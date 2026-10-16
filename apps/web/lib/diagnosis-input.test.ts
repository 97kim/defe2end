import { describe, expect, it } from "vitest";
import { buildDiagnosisPrompt, DIAGNOSIS_DOM_BYTES, diagnosisLogText, diagnosisThreadId, pickDiagnosisArtifacts } from "./diagnosis-input";
import type { ArtifactView, RunStepView } from "./run-read";

const step = (index: number, status: "passed" | "failed" | null, extra: Partial<RunStepView> = {}): RunStepView => ({
  index,
  stepId: `s${index}`,
  action: "click",
  maxAttempts: 2,
  ...extra,
  result: status
    ? { status, attempts: 1, startedAt: "", durationMs: 1, errorCode: status === "failed" ? "selector_not_found" : null, errorMessage: status === "failed" ? "No #buy on https://shop.example.com/cart?token=abc123 for kim@example.com" : null, expected: null, actual: null, possibleDuplicate: false }
    : null,
});

describe("diagnosis prompt", () => {
  const base = { scenarioName: "Checkout", baseUrl: "https://shop.example.com", runError: null, logText: null, domSummary: null };

  it("keeps the failed step and its neighbours only, masked", () => {
    const steps = [step(0, "passed", { selector: "#first" }), step(1, "passed", { selector: "#prev" }), step(2, "failed", { selector: "#buy" }), step(3, null, { selector: "#next" }), step(4, null, { selector: "#last" })];
    const p = buildDiagnosisPrompt({ ...base, steps })!;
    expect(p).toContain("#prev");
    expect(p).toContain("#3 (FAILED) click");
    expect(p).toContain("#next");
    expect(p).not.toContain("#first");
    expect(p).not.toContain("#last");
    expect(p).not.toContain("abc123");
    expect(p).not.toContain("kim@example.com");
    expect(p).toContain("[email]");
  });

  it("caps logs at 30 lines and the DOM summary at 8 KB, masking both", () => {
    const logText = Array.from({ length: 50 }, (_, i) => `line ${i} call 010-1234-5678`).join("\n");
    const domSummary = "<div>" + "x".repeat(DIAGNOSIS_DOM_BYTES * 2) + "</div>";
    const p = buildDiagnosisPrompt({ ...base, steps: [step(0, "failed")], logText, domSummary })!;
    expect(p).toContain("line 49");
    expect(p).not.toContain("line 19 ");
    expect(p).toContain("Browser log (last 30)");
    expect(p).not.toContain("010-1234-5678");
    const dom = p.slice(p.indexOf("DOM summary):\n") + 14);
    expect(Buffer.byteLength(dom)).toBeLessThanOrEqual(DIAGNOSIS_DOM_BYTES + 4);
  });

  it("nothing to diagnose without a failure", () => {
    expect(buildDiagnosisPrompt({ ...base, steps: [step(0, "passed")] })).toBeNull();
  });
});

describe("diagnosis artifacts", () => {
  const art = (id: string, kind: ArtifactView["kind"], stepIndex: number | null, attempt: number): ArtifactView => ({ id, kind, stepIndex, attempt, name: id, sizeBytes: 1, url: `/a/${id}` });
  it("uses the given attempt's DOM summary and nearby logs only", () => {
    const steps = [step(0, "passed"), step(1, "passed"), step(2, "failed"), step(3, null), step(4, null)];
    const artifacts = [
      art("dom-old", "dom_summary", 2, 1),
      art("log-old", "log", 2, 1),
      art("dom-new", "dom_summary", 2, 2),
      art("dom-other-step", "dom_summary", 1, 2),
      art("log-run", "log", null, 2),
      art("log-prev", "log", 1, 2),
      art("log-far", "log", 4, 2),
      art("shot", "screenshot", 2, 2),
    ];
    const picked = pickDiagnosisArtifacts(steps, artifacts, 2);
    expect(picked.dom?.id).toBe("dom-new");
    expect(picked.logs.map((a) => a.id)).toEqual(["log-run", "log-prev"]);
    expect(pickDiagnosisArtifacts(steps, artifacts, 1)).toEqual({ dom: artifacts[0], logs: [artifacts[1]] });
  });
});

describe("diagnosis browser log", () => {
  const art = (id: string, stepIndex: number | null): ArtifactView => ({ id, kind: "log", stepIndex, attempt: 1, name: `step-${(stepIndex ?? 0) + 1}-console`, sizeBytes: 1, url: `/a/${id}` });

  it("puts the failed stretch's step logs in step order, marked by step, and keeps the last 30 lines of it", () => {
    const steps = [step(0, "passed"), step(1, "passed"), step(2, "failed"), step(3, null)];
    const { logs } = pickDiagnosisArtifacts(steps, [art("next", 3), art("failed", 2), art("far", 0), art("prev", 1)], 1);
    expect(logs.map((a) => a.id)).toEqual(["prev", "failed", "next"]);
    const texts: Record<string, string> = {
      prev: Array.from({ length: 20 }, (_, i) => `prev ${i}`).join("\n") + "\n",
      failed: "console.error: Login failed for kim@example.com\nresponse 404: GET https://shop.test/missing.json?token=abc123\n… 3 more browser log lines omitted\n",
      next: Array.from({ length: 10 }, (_, i) => `next ${i}`).join("\n"),
    };
    const logText = diagnosisLogText(logs.map((a) => ({ stepIndex: a.stepIndex, text: texts[a.id]! })));
    expect(logText).toContain("[step 3] console.error: Login failed");
    const p = buildDiagnosisPrompt({ scenarioName: "Checkout", baseUrl: "https://shop.test", runError: null, domSummary: null, steps, logText })!;
    const section = p.split("Browser log (last 30):\n")[1]!.split("\n\n")[0]!.split("\n");
    expect(p).toContain("Browser log (last 30)");
    expect(p).toContain("[step 3] … 3 more browser log lines omitted");
    expect(p).toContain("[step 2] prev 19");
    expect(p).not.toContain("prev 2\n");
    expect(p).not.toContain("kim@example.com");
    expect(p).not.toContain("abc123");
    expect(section).toHaveLength(30);
    expect(diagnosisLogText([{ stepIndex: 0, text: null }])).toBeNull();
  });
});

describe("diagnosisThreadId", () => {
  it("fits the app's 64-character thread id limit and differs each time", () => {
    const a = diagnosisThreadId();
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a.startsWith("diagnosis-")).toBe(true);
    expect(diagnosisThreadId()).not.toBe(a);
  });
});
