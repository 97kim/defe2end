import { maskSecrets, redactText, redactUrl } from "@defe2end/shared";
import type { BrowserContext, Request } from "playwright";

/** One stored line at most this long (characters), after masking. */
export const BROWSER_LOG_LINE_CHARS = 500;
/** Lines kept per step; the rest are counted as omitted. */
export const BROWSER_LOG_STEP_LINES = 50;
/** Lines kept for the whole run (all steps together). */
export const BROWSER_LOG_RUN_LINES = 500;

export interface BrowserLogLimits {
  lineChars: number;
  stepLines: number;
  runLines: number;
}

/**
 * The page's own trouble during a run — console errors and warnings, uncaught exceptions, failed requests and
 * 4xx/5xx responses — of every page in the context (popups included), kept per step for the `log` artifact
 * `step-{n}-console` (stage 6 contract section 8). Each line has the run's secret values masked first, then
 * personal data and URL query values (`redactText`); request URLs are kept only in their redacted form.
 */
export class BrowserLog {
  private readonly lines = new Map<number, string[]>();
  private readonly omitted = new Map<number, number>();
  private kept = 0;

  constructor(
    private readonly secrets: string[],
    private readonly limits: BrowserLogLimits = { lineChars: BROWSER_LOG_LINE_CHARS, stepLines: BROWSER_LOG_STEP_LINES, runLines: BROWSER_LOG_RUN_LINES },
  ) {}

  /** Listens on the whole context; `stepIndex` says which step is running (events before the first go to it). */
  attach(context: BrowserContext, stepIndex: () => number): void {
    const at = () => Math.max(0, stepIndex());
    context.on("console", (msg) => {
      const type = msg.type();
      if (type === "error" || type === "warning") this.add(at(), `console.${type}: ${msg.text()}`);
    });
    context.on("weberror", (err) => this.add(at(), `page error: ${err.error().message}`));
    context.on("requestfailed", (request) => this.add(at(), `request failed: ${this.request(request)} (${request.failure()?.errorText ?? "unknown error"})`));
    context.on("response", (response) => {
      if (response.status() >= 400) this.add(at(), `response ${response.status()}: ${this.request(response.request())}`);
    });
  }

  add(stepIndex: number, text: string): void {
    if (this.kept >= this.limits.runLines || (this.lines.get(stepIndex)?.length ?? 0) >= this.limits.stepLines) {
      this.omitted.set(stepIndex, (this.omitted.get(stepIndex) ?? 0) + 1);
      return;
    }
    // Masked before cutting, so a cut can't leave part of a secret behind.
    let line = redactText(text, { secrets: this.secrets }).replace(/\s*\n\s*/g, " ");
    if (line.length > this.limits.lineChars) line = line.slice(0, this.limits.lineChars) + "…";
    const kept = this.lines.get(stepIndex) ?? [];
    kept.push(line);
    this.lines.set(stepIndex, kept);
    this.kept++;
  }

  /** The step's text (with an "N omitted" line when over a limit) and forgets it; null when nothing came. */
  take(stepIndex: number): string | null {
    const lines = this.lines.get(stepIndex) ?? [];
    const omitted = this.omitted.get(stepIndex) ?? 0;
    this.lines.delete(stepIndex);
    this.omitted.delete(stepIndex);
    if (omitted > 0) lines.push(`… ${omitted} more browser log line${omitted === 1 ? "" : "s"} omitted`);
    return lines.length ? lines.join("\n") + "\n" : null;
  }

  private request(request: Request): string {
    return `${request.method()} ${redactUrl(maskSecrets(request.url(), this.secrets))}`;
  }
}
