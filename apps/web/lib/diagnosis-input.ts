// Stage 6 contract section 8: what a failure diagnosis sends — the failed step with the steps around it, the errors,
// up to 30 browser log lines of that stretch and the stored `dom_summary` (≤ 8 KB), every part through `redactText`.
// No screenshots. The screen shows exactly this text before it goes out.
import { redactText } from "@defe2end/shared";
import type { ArtifactView, RunStepView } from "./run-read";

export const DIAGNOSIS_LOG_LINES = 30;
export const DIAGNOSIS_DOM_BYTES = 8 * 1024;

export interface DiagnosisSource {
  scenarioName: string;
  baseUrl: string;
  steps: RunStepView[];
  /** Run-level error (infrastructure), if any. */
  runError: string | null;
  /** Browser log text of the failed stretch (the run's `log` artifacts), newest last. */
  logText: string | null;
  /** The `dom_summary` artifact of the failed step. */
  domSummary: string | null;
}

function clipBytes(text: string, max: number): string {
  // Runs in the browser too: no Buffer.
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  return new TextDecoder().decode(bytes.subarray(0, max)).replace(/\uFFFD+$/, "") + "\n…";
}

function stepLine(s: RunStepView, failed: boolean): string {
  const parts = [`#${s.index + 1}${failed ? " (FAILED)" : ""} ${s.action}`];
  if (s.name) parts.push(`name: ${s.name}`);
  if (s.selector) parts.push(`selector: ${s.selector}`);
  if (s.url) parts.push(`url: ${s.url}`);
  if (s.expected) parts.push(`expected: ${s.expected}`);
  const r = s.result;
  if (r) {
    parts.push(`status: ${r.status}`);
    if (r.errorCode) parts.push(`errorCode: ${r.errorCode}`);
    if (r.errorMessage) parts.push(`error: ${r.errorMessage}`);
    if (r.actual) parts.push(`actual: ${r.actual}`);
  }
  return parts.join("\n  ");
}

/** The masked prompt, or null when the run has no failed step to diagnose. */
export function buildDiagnosisPrompt(source: DiagnosisSource): string | null {
  const failedAt = source.steps.findIndex((s) => s.result?.status === "failed");
  if (failedAt < 0 && !source.runError) return null;
  const around = failedAt < 0 ? [] : source.steps.slice(Math.max(0, failedAt - 1), failedAt + 2);
  const sections = [`Scenario: ${source.scenarioName}`, `Base URL: ${source.baseUrl}`];
  if (around.length) sections.push(`Steps around the failure:\n${around.map((s) => stepLine(s, s.index === source.steps[failedAt]!.index)).join("\n")}`);
  if (source.runError) sections.push(`Run error:\n${source.runError}`);
  const logs = (source.logText ?? "").split("\n").filter((l) => l.trim()).slice(-DIAGNOSIS_LOG_LINES);
  if (logs.length) sections.push(`Browser log (last ${logs.length}):\n${logs.join("\n")}`);
  if (source.domSummary?.trim()) sections.push(`Page structure at the failure (DOM summary):\n${clipBytes(source.domSummary, DIAGNOSIS_DOM_BYTES)}`);
  return redactText(sections.join("\n\n"));
}

/**
 * The stored artifacts a diagnosis of `attempt` uses: the failed step's `dom_summary` and the `log` artifacts of the
 * failed step, its neighbours and the whole run — all from that attempt only, so a retry never gets an earlier
 * attempt's page or logs. The runner stores each step's browser log as `step-{n}-console` with its step index.
 */
export function pickDiagnosisArtifacts(steps: RunStepView[], artifacts: ArtifactView[], attempt: number): { dom: ArtifactView | null; logs: ArtifactView[] } {
  const failed = steps.find((s) => s.result?.status === "failed");
  const ofAttempt = artifacts.filter((a) => a.attempt === attempt);
  const dom = failed ? (ofAttempt.find((a) => a.kind === "dom_summary" && a.stepIndex === failed.index) ?? null) : null;
  const near = (i: number | null) => i === null || (failed !== undefined && Math.abs(i - failed.index) <= 1);
  // In step order (run-wide logs first), so the last lines kept by the 30-line cap are those of the failure.
  const logs = ofAttempt.filter((a) => a.kind === "log" && near(a.stepIndex)).sort((a, b) => (a.stepIndex ?? -1) - (b.stepIndex ?? -1));
  return { dom, logs };
}

/** The picked `log` artifacts' text as one log, each line of a step's artifact marked with its step number. */
export function diagnosisLogText(logs: { stepIndex: number | null; text: string | null }[]): string | null {
  const lines = logs.flatMap(({ stepIndex, text }) =>
    (text ?? "")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => (stepIndex === null ? l : `[step ${stepIndex + 1}] ${l}`)),
  );
  return lines.length ? lines.join("\n") : null;
}

/** The app takes thread ids up to 64 characters (`ai:send`); a run id plus a UUID went past that. */
export function diagnosisThreadId(): string {
  return `diagnosis-${crypto.randomUUID()}`;
}
