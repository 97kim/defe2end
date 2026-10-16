import { z } from "zod";
import { VERSIONS } from "./version.js";

/** Step format (docs/action-spec.md section 1). Unreleased, so changes keep version 1. */
export const STEP_FORMAT_VERSION = VERSIONS.stepFormat;

export const STEP_ACTIONS = [
  // 3.1 navigation and interaction
  "goto",
  "click",
  "fill",
  "select",
  "pressKey",
  "hover",
  "scroll",
  "wait",
  "uploadFile",
  "clickFirstEnabled",
  // 3.2 waits and checks
  "waitForSelector",
  "waitForUrl",
  "assertVisible",
  "assertVisibleOrWarn",
  "assertText",
  "assertUrl",
  "assertTitle",
  "assertCount",
  "assertExists",
  "assertJsonLd",
  "assertResponse",
  "screenshot",
  // 3.3 new window
  "clickAndWaitPopup",
  "clickInPopup",
  "fillInPopup",
  "assertVisibleInPopup",
  "assertPopupUrl",
  "closePopup",
  // 3.4 iframe
  "clickInIframe",
  "fillInIframe",
  "assertVisibleInIframe",
  // 3.5 dialogs
  "clickAndAcceptDialog",
  "clickAndDismissDialog",
  "clickAndSubmitPrompt",
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** Action-specific keys. `id`, `action`, `name`, `optional` and `timeout` apply to every action. */
export type StepField = "url" | "selector" | "value" | "expected" | "position" | "threshold" | "mask";

/**
 * Which action-specific keys each action uses, in editor order (spec section 3). Keys an action doesn't use are
 * still accepted and kept on save (spec section 1), but nothing checks or reads them.
 */
export const STEP_FIELDS: Record<StepAction, readonly StepField[]> = {
  goto: ["url"],
  click: ["selector", "position"],
  fill: ["selector", "value"],
  select: ["selector", "value"],
  pressKey: ["selector", "value"],
  hover: ["selector"],
  scroll: ["selector", "value"],
  wait: [],
  uploadFile: ["selector", "value"],
  clickFirstEnabled: ["selector", "expected"],
  waitForSelector: ["selector"],
  waitForUrl: ["expected"],
  assertVisible: ["selector"],
  assertVisibleOrWarn: ["selector", "expected"],
  assertText: ["selector", "expected"],
  assertUrl: ["expected"],
  assertTitle: ["expected"],
  assertCount: ["selector", "expected"],
  assertExists: ["selector"],
  assertJsonLd: ["selector", "expected"],
  assertResponse: ["expected", "value"],
  screenshot: ["threshold", "mask"],
  clickAndWaitPopup: ["selector"],
  clickInPopup: ["selector"],
  fillInPopup: ["selector", "value"],
  assertVisibleInPopup: ["selector"],
  assertPopupUrl: ["expected"],
  closePopup: [],
  clickInIframe: ["selector", "value"],
  fillInIframe: ["selector", "value", "expected"],
  assertVisibleInIframe: ["selector", "value"],
  clickAndAcceptDialog: ["selector", "expected"],
  clickAndDismissDialog: ["selector", "expected"],
  clickAndSubmitPrompt: ["selector", "value", "expected"],
};

/** Spec section 2.1 and 2.2/2.9 timings. */
export const STEP_TIMEOUT_DEFAULT_MS = 30_000;
export const WAIT_DEFAULT_MS = 1000;
export const STEP_TIMEOUT_MAX_MS = 600_000;
export const SETTLE_AFTER_STEP_MS = 500;
export const STEP_RETRY_DELAY_MS = 1000;
export const STEP_MAX_ATTEMPTS = 2;
export const SCREENSHOT_THRESHOLD_DEFAULT = 5;

/** The timeout a step runs with (spec 2.1). */
export function stepTimeout(step: { action: StepAction; timeout?: number }): number {
  return step.timeout ?? (step.action === "wait" ? WAIT_DEFAULT_MS : STEP_TIMEOUT_DEFAULT_MS);
}

/** Display name: `name`, or `Step {n}: {action}` with a 1-based number. */
export function stepDisplayName(step: { action: string; name?: string }, index: number): string {
  return step.name?.trim() ? step.name : `Step ${index + 1}: ${step.action}`;
}

const hasTemplate = (text: string) => text.includes("{{");

// ---- waitForUrl pattern (spec 3.2) ----

/** A `waitForUrl` pattern without `*`: alternatives of literal parts. Returns an error message when the braces don't pair. */
export type UrlPattern = { ok: true; kind: "wildcard"; pattern: string } | { ok: true; kind: "alternatives"; options: string[] } | { ok: false; message: string };

export function parseUrlPattern(pattern: string): UrlPattern {
  if (pattern.includes("*")) return { ok: true, kind: "wildcard", pattern };
  // Each part is a list of strings; the result is their cross product.
  let results: string[] = [""];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      results = results.map((r) => r + next);
      i += 2;
      continue;
    }
    if (ch === "}") return { ok: false, message: "unmatched } in URL pattern" };
    if (ch === "{") {
      const group: string[] = [""];
      i++;
      let closed = false;
      while (i < pattern.length) {
        const c = pattern[i]!;
        if (c === "\\") {
          group[group.length - 1] += pattern[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (c === "{") return { ok: false, message: "nested { in URL pattern" };
        if (c === "}") {
          closed = true;
          i++;
          break;
        }
        if (c === ",") group.push("");
        else group[group.length - 1] += c;
        i++;
      }
      if (!closed) return { ok: false, message: "unmatched { in URL pattern" };
      results = results.flatMap((r) => group.map((g) => r + g));
      continue;
    }
    results = results.map((r) => r + ch);
    i++;
  }
  return { ok: true, kind: "alternatives", options: results };
}

/** Wildcard comparison (spec 2.5): substring without `*`; with `*`, an unanchored pattern where only `*` is special. Case-sensitive. */
export function wildcardMatch(actual: string, expected: string): boolean {
  if (!expected.includes("*")) return actual.includes(expected);
  const source = expected
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(source).test(actual);
}

export function urlPatternMatches(url: string, pattern: UrlPattern): boolean {
  if (!pattern.ok) return false;
  if (pattern.kind === "wildcard") return wildcardMatch(url, pattern.pattern);
  return pattern.options.some((option) => url.includes(option));
}

// ---- assertJsonLd condition (spec 3.2) ----

export type JsonLdSegment = { name: string; indexes: (number | "*")[] };
export type JsonLdCondition =
  | { ok: true; path: JsonLdSegment[]; op: "exists" | "equals" | "contains"; value?: string }
  | { ok: false; message: string };

export function parseJsonLdCondition(input: string): JsonLdCondition {
  const text = input.trim();
  if (!text) return { ok: false, message: "condition is empty" };
  const eq = text.indexOf("=");
  let pathText = text;
  let op: "exists" | "equals" | "contains" = "exists";
  let value: string | undefined;
  if (eq >= 0) {
    const contains = eq > 0 && text[eq - 1] === "*";
    // No trimming around the operator: `@type = Product` reads key `@type ` and value ` Product` (spec 3.2).
    pathText = text.slice(0, contains ? eq - 1 : eq);
    value = text.slice(eq + 1);
    op = contains ? "contains" : "equals";
    if (!pathText) return { ok: false, message: "condition has no path before the operator" };
    if (!value) return { ok: false, message: "condition has no value after the operator" };
  }
  const path: JsonLdSegment[] = [];
  for (const part of pathText.split(".")) {
    const match = /^([^.[\]]+)((?:\[[^\]]*\])*)$/.exec(part);
    if (!part) return { ok: false, message: "condition path has an empty segment" };
    if (part.startsWith("[")) return { ok: false, message: "condition path segment starts with [" };
    if (!match) return { ok: false, message: `invalid path segment: ${part}` };
    const indexes: (number | "*")[] = [];
    for (const [, inner] of match[2]!.matchAll(/\[([^\]]*)\]/g)) {
      if (inner === "*") indexes.push("*");
      else if (/^\d+$/.test(inner!)) indexes.push(Number(inner));
      else return { ok: false, message: `invalid index [${inner}]` };
    }
    path.push({ name: match[1]!, indexes });
  }
  return { ok: true, path, op, ...(value !== undefined ? { value } : {}) };
}

// ---- uploadFile values (spec 3.1 + the defE2End `attachment:<name>` extension) ----

export const ATTACHMENT_TOKEN_PREFIX = "attachment:";
export const ATTACHMENT_NAME_MAX = 200;

/** Workspace attachment name rules (already trimmed). `undefined` when the name is fine. */
export function attachmentNameIssue(name: string): string | undefined {
  if (name.length === 0) return "Name the attachment";
  if (name.length > ATTACHMENT_NAME_MAX) return `Attachment names are at most ${ATTACHMENT_NAME_MAX} characters`;
  if (!/^[^\u0000-\u001f\u007f/\\]+$/.test(name)) return "Attachment names can't contain control characters or slashes";
  return undefined;
}

/** The tokens of an uploadFile value: separated by whitespace and commas. */
export function uploadTokens(value: string): string[] {
  return value.split(/[\s,]+/).filter(Boolean);
}

/**
 * `attachment:<name>` for a workspace attachment. Spaces, commas and `%` in the name are percent-encoded so the
 * token survives the separators; everything else stays readable.
 */
export function attachmentToken(name: string): string {
  return ATTACHMENT_TOKEN_PREFIX + name.replace(/[%\s,]/g, (c) => encodeURIComponent(c));
}

export type UploadToken = { kind: "url"; url: string } | { kind: "attachment"; name: string } | { kind: "invalid"; message: string };

/** Anything not starting with `attachment:` is a URL (format checked by the caller). */
export function parseUploadToken(token: string): UploadToken {
  if (!token.toLowerCase().startsWith(ATTACHMENT_TOKEN_PREFIX)) return { kind: "url", url: token };
  const raw = token.slice(ATTACHMENT_TOKEN_PREFIX.length);
  if (raw.includes("{{")) return { kind: "invalid", message: "attachment names can't contain {{variables}}: attachments are fixed when the run is requested" };
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return { kind: "invalid", message: `invalid attachment token: ${token}` };
  }
  const issue = name !== name.trim() ? "Attachment names can't start or end with spaces" : attachmentNameIssue(name);
  return issue ? { kind: "invalid", message: `${issue}: ${token}` } : { kind: "attachment", name };
}

/** Attachment names referenced by uploadFile steps, each once, in step order, with the first step index using it. */
export function uploadAttachmentRefs(steps: readonly { action: string; value?: string }[]): { name: string; stepIndex: number }[] {
  const seen = new Map<string, number>();
  steps.forEach((step, stepIndex) => {
    if (step.action !== "uploadFile" || !step.value) return;
    for (const token of uploadTokens(step.value)) {
      const parsed = parseUploadToken(token);
      if (parsed.kind === "attachment" && !seen.has(parsed.name)) seen.set(parsed.name, stepIndex);
    }
  });
  return [...seen].map(([name, stepIndex]) => ({ name, stepIndex }));
}

// ---- save-time checks (spec section 3 "검증") ----

export interface StepIssue {
  field: StepField | "action";
  message: string;
}

type StepInput = {
  action: StepAction;
  selector?: string;
  url?: string;
  value?: string;
  expected?: string;
  position?: { x: number; y: number };
  threshold?: number;
  mask?: string;
};

/**
 * Save-time checks of one step. Values containing `{{` skip format checks; the runner checks them again
 * after substitution (spec 2.6).
 */
export function stepIssues(step: StepInput): StepIssue[] {
  const issues: StepIssue[] = [];
  const add = (field: StepIssue["field"], message: string) => void issues.push({ field, message });
  const { action } = step;
  const allowed = STEP_FIELDS[action];
  const need = (field: "selector" | "url" | "value" | "expected", what: string) => {
    if (!step[field]) add(field, `${action} needs ${what}`);
  };
  const format = (field: "value" | "expected", check: (text: string) => string | undefined) => {
    const text = step[field];
    if (text === undefined || hasTemplate(text)) return;
    const message = check(text);
    if (message) add(field, message);
  };
  // Range checks of the keys only some actions use; an unused key keeps whatever it holds (spec section 1).
  if (allowed.includes("threshold") && step.threshold !== undefined && !(step.threshold >= 0 && step.threshold <= 100)) add("threshold", "threshold must be from 0 to 100");
  if (allowed.includes("position") && step.position && !(Number.isInteger(step.position.x) && Number.isInteger(step.position.y))) add("position", "position must be whole pixels");
  switch (action) {
    case "goto":
      need("url", "a URL or a path");
      break;
    case "click":
      if (!step.selector && !step.position) add("selector", "click needs a selector or a position");
      break;
    case "select":
      need("selector", "a selector");
      need("value", "an option value or label");
      break;
    case "pressKey":
      need("value", "a key");
      break;
    case "uploadFile":
      need("selector", "a file input selector");
      need("value", "a file URL");
      if (step.value) {
        // `attachment:` tokens are pinned at request time, so they are checked even when the value has variables.
        for (const token of uploadTokens(step.value)) {
          const parsed = parseUploadToken(token);
          if (parsed.kind === "attachment") continue;
          if (parsed.kind === "invalid") add("value", parsed.message);
          else if (!hasTemplate(step.value) && !/^https?:\/\//i.test(token)) add("value", "every file must be an http(s):// URL or attachment:<name>");
        }
      }
      break;
    case "waitForUrl":
      need("expected", "a URL pattern");
      format("expected", (text) => {
        const parsed = parseUrlPattern(text);
        return parsed.ok ? undefined : parsed.message;
      });
      break;
    case "assertText":
      need("selector", "a selector");
      need("expected", "the expected text");
      break;
    case "assertUrl":
    case "assertTitle":
    case "assertPopupUrl":
      need("expected", "the expected value");
      break;
    case "assertCount":
      need("selector", "a selector");
      if (step.expected === undefined || step.expected === "") add("expected", "assertCount needs a count");
      else format("expected", (text) => (/^\d+$/.test(text.trim()) ? undefined : "assertCount needs a whole number (0 or more)"));
      break;
    case "assertJsonLd":
      need("expected", "a condition");
      if (step.expected) {
        format("expected", (text) => {
          const parsed = parseJsonLdCondition(text);
          return parsed.ok ? undefined : parsed.message;
        });
      }
      break;
    case "assertResponse":
      need("expected", "a URL pattern");
      format("value", (text) => {
        if (text.trim() === "") return undefined;
        const n = Number(text.trim());
        return /^\d+$/.test(text.trim()) && n >= 100 && n <= 599 ? undefined : "status must be a whole number from 100 to 599";
      });
      break;
    case "clickInIframe":
    case "fillInIframe":
    case "assertVisibleInIframe":
      need("selector", "an iframe selector");
      need("value", "an inner element selector");
      if (step.selector && !hasTemplate(step.selector) && !/iframe/i.test(step.selector)) add("selector", `${action} needs a selector that names an iframe`);
      if (action === "fillInIframe" && step.expected === undefined) add("expected", "fillInIframe needs the text to enter (may be empty)");
      break;
    case "clickAndSubmitPrompt":
      need("selector", "a selector");
      need("value", "the prompt text");
      break;
    case "wait":
    case "screenshot":
    case "closePopup":
    case "scroll":
      break;
    default:
      // Every other action with a selector field needs it (fill, hover, clickFirstEnabled, waitForSelector, assertVisible…).
      if (allowed.includes("selector")) need("selector", "a selector");
  }
  return issues;
}

const positionSchema = z.strictObject({ x: z.number(), y: z.number() });

/**
 * Unknown actions and unknown keys are rejected on save, and so is a step its action can't run (`stepIssues`).
 * Known keys the action doesn't use are kept as they are (spec section 1).
 */
export const stepSchema = z
  .strictObject({
    id: z.string().min(1).max(64),
    action: z.enum(STEP_ACTIONS),
    name: z.string().max(200).optional(),
    selector: z.string().max(2000).optional(),
    url: z.string().max(2000).optional(),
    value: z.string().max(10_000).optional(),
    expected: z.string().max(10_000).optional(),
    timeout: z.number().int().positive().max(STEP_TIMEOUT_MAX_MS).optional(),
    optional: z.boolean().optional(),
    position: positionSchema.optional(),
    threshold: z.number().optional(),
    mask: z.string().max(2000).optional(),
  })
  .superRefine((step, ctx) => {
    for (const { field, message } of stepIssues(step)) ctx.addIssue({ code: "custom", path: [field], message });
  });
export type Step = z.infer<typeof stepSchema>;

export const stepsSchema = z
  .array(stepSchema)
  .max(500)
  .refine((steps) => new Set(steps.map((s) => s.id)).size === steps.length, { message: "Step ids must be unique" });

/** One scenario in an export file. Sites are referenced by name; no ids, no secret values. */
export const exportedScenarioSchema = z.strictObject({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).default(""),
  site: z.string().min(1).max(200),
  tags: z.array(z.string().min(1).max(100)).default([]),
  steps: stepsSchema,
});
export type ExportedScenario = z.infer<typeof exportedScenarioSchema>;

export const SCENARIO_EXPORT_FORMAT = "defe2end.scenario";

export const scenarioExportSchema = z.strictObject({
  format: z.literal(SCENARIO_EXPORT_FORMAT),
  formatVersion: z.literal(1),
  stepFormatVersion: z.literal(STEP_FORMAT_VERSION),
  scenarios: z.array(exportedScenarioSchema),
});
export type ScenarioExport = z.infer<typeof scenarioExportSchema>;
