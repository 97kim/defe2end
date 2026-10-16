// Stage 7 contract: the shared vocabulary of visual regression, masking and environment comparison (sections
// 1, 2, 5 and 7). The server, the runner and the desktop app all read these, so change them only through the
// contract.
import { createParser } from "css-selector-parser";
import { z } from "zod";

/** Visual regression verdict of one screenshot step (contract sections 1 and 4). */
export const VISUAL_VERDICTS = ["created", "match", "shifted", "changed", "size_mismatch", "skipped", "incomparable"] as const;
export type VisualVerdict = (typeof VISUAL_VERDICTS)[number];
/** Verdicts that make the step a warning (the run still passes). */
export const VISUAL_WARNING_VERDICTS: readonly VisualVerdict[] = ["changed", "size_mismatch"];

/** Environment comparison verdict, per step and overall, screen and structure apart (section 6). */
export const COMPARISON_VERDICTS = ["same", "different", "incomparable"] as const;
export type ComparisonVerdict = (typeof COMPARISON_VERDICTS)[number];

export const COMPARISON_STATUSES = ["running", "comparing", "done", "error", "cancelled"] as const;
export type ComparisonStatus = (typeof COMPARISON_STATUSES)[number];

export const COMPARISON_SIDES = ["left", "right"] as const;
export type ComparisonSide = (typeof COMPARISON_SIDES)[number];

/** Where the browser ran; part of the baseline key. */
export const VISUAL_RUNTIMES = ["server", "desktop-mac", "desktop-windows"] as const;
export type VisualRuntime = (typeof VISUAL_RUNTIMES)[number];

export const BASELINE_SOURCES = ["auto", "approved"] as const;
export type BaselineSource = (typeof BASELINE_SOURCES)[number];

/** Instance constants (section 1). Verdicts use raw values; only the display rounds. */
export const VISUAL_COMPARE = {
  /** Step `threshold` default, in percent of pixels. */
  defaultTolerancePercent: 5,
  /**
   * Over the tolerance, the current image is moved up to this many pixels each way and compared again on the
   * overlap; the smallest difference within the tolerance makes it `shifted`, else `changed`.
   */
  shiftSearchPx: 2,
  /** Per-pixel color sensitivity of the pixel comparison. */
  colorThreshold: 0.05,
} as const;

/** Baseline versions always kept per baseline, newest first (section 1, baseline storage). */
export const BASELINE_KEEP_VERSIONS = 5;

/**
 * Version of the masking rules (what is hidden and how, section 5). Recorded in every capture's render
 * conditions: a baseline taken under other rules is `incomparable`, not a difference. Bump it whenever the
 * runner hides something it did not before or hides it differently.
 */
export const MASKING_POLICY_VERSION = 1;

/**
 * What a capture was rendered under (section 1). Kept with every baseline version and screenshot result; when
 * they differ the verdict is `incomparable`. Not part of the baseline key.
 */
export const renderConditionsSchema = z.strictObject({
  browserVersion: z.string().min(1).max(100),
  deviceScaleFactor: z.number().positive().max(10),
  viewport: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
  /** Identifies the installed font set, so a font change reads as a condition change. */
  fontSet: z.string().min(1).max(200),
  maskingPolicyVersion: z.number().int().min(1),
});
export type RenderConditions = z.infer<typeof renderConditionsSchema>;

/** Names of the conditions that differ (empty when the two captures are comparable). */
export function renderConditionDiff(a: RenderConditions, b: RenderConditions): (keyof RenderConditions)[] {
  const out: (keyof RenderConditions)[] = [];
  if (a.browserVersion !== b.browserVersion) out.push("browserVersion");
  if (a.deviceScaleFactor !== b.deviceScaleFactor) out.push("deviceScaleFactor");
  if (a.viewport.width !== b.viewport.width || a.viewport.height !== b.viewport.height) out.push("viewport");
  if (a.fontSet !== b.fontSet) out.push("fontSet");
  if (a.maskingPolicyVersion !== b.maskingPolicyVersion) out.push("maskingPolicyVersion");
  return out;
}

/**
 * Masking settings of one run, fixed in the run snapshot and sent to the app (section 5). `enabled` is the
 * scenario switch: off turns site selectors and automatic detection off, never field or step masks.
 */
export const maskingSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** The site's selector list, already split. */
  selectors: z.array(z.string()),
  policyVersion: z.number().int().min(1),
});
export type MaskingSettings = z.infer<typeof maskingSettingsSchema>;

// --- Mask selector lists (section 5, selector validation) ----------------------------

/**
 * Splits a selector list on commas and line breaks. Commas inside parentheses, brackets or quotes are part of
 * a selector (`:is(.a, .b)`, `[title="a, b"]`). Items are trimmed and blanks dropped.
 */
export function splitSelectorList(text: string): string[] {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) current += text[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      current += ch + text[++i];
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    else if (depth === 0 && (ch === "," || ch === "\n" || ch === "\r")) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map((s) => s.trim()).filter(Boolean);
}

/** Longest single selector and most selectors one list may hold. */
export const MASK_SELECTOR_LIMITS = { maxLength: 500, maxCount: 200 } as const;

const parseCss = createParser({ syntax: "latest", strict: true });

/** AST nodes `querySelectorAll` either rejects without a namespace map, or never matches. */
const UNSUPPORTED_NODES: Record<string, string> = {
  NamespaceName: "namespace prefixes are not supported",
  NoNamespace: "namespace prefixes are not supported",
  PseudoElement: "pseudo-elements never match an element",
  NestingSelector: "the nesting selector & is not supported",
  Substitution: "substitutions are not supported",
};

function findUnsupported(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findUnsupported(item);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const type = (node as { type?: unknown }).type;
  if (typeof type === "string" && UNSUPPORTED_NODES[type]) return UNSUPPORTED_NODES[type]!;
  for (const value of Object.values(node)) {
    const found = findUnsupported(value);
    if (found) return found;
  }
  return null;
}

/**
 * Whether one selector is valid standard CSS that `querySelectorAll` accepts, checked without a browser (the
 * web server validates on save). Only plain CSS: engine-specific locator forms such as `text=` or `role=` are
 * refused, because the same list is applied by an in-page script through the DOM API, which knows only CSS.
 * Returns the reason when invalid.
 */
export function checkCssSelector(selector: string): string | null {
  if (selector.length > MASK_SELECTOR_LIMITS.maxLength) return `longer than ${MASK_SELECTOR_LIMITS.maxLength} characters`;
  let ast: unknown;
  try {
    ast = parseCss(selector);
  } catch (e) {
    return (e instanceof Error ? e.message : String(e)).replace(/^css-selector-parser parse error:\s*/, "");
  }
  if (((ast as { rules?: unknown[] }).rules ?? []).length !== 1) return "one selector per item";
  return findUnsupported(ast);
}

export type MaskSelectorListResult =
  | { ok: true; selectors: string[] }
  /** `index` is 0-based; `position` = index + 1 for messages ("item 3"). */
  | { ok: false; index: number; position: number; selector: string; reason: string };

/** Splits and checks a selector list; the first invalid item fails the whole list (save refused with 400). */
export function parseMaskSelectorList(text: string): MaskSelectorListResult {
  const selectors = splitSelectorList(text);
  if (selectors.length > MASK_SELECTOR_LIMITS.maxCount) {
    const index = MASK_SELECTOR_LIMITS.maxCount;
    return { ok: false, index, position: index + 1, selector: selectors[index]!, reason: `more than ${MASK_SELECTOR_LIMITS.maxCount} selectors` };
  }
  for (const [index, selector] of selectors.entries()) {
    const reason = checkCssSelector(selector);
    if (reason) return { ok: false, index, position: index + 1, selector, reason };
  }
  return { ok: true, selectors };
}

// --- App features a run needs (section 7) -------------------------------------------

export const SCREEN_FEATURES = {
  masking: "masking-v1",
  visualCompare: "visual-compare-v1",
  a11ySnapshot: "a11y-snapshot-v1",
} as const;

/**
 * Stage 7 features a desktop app must announce for this run: `masking-v1` always, `visual-compare-v1` when a
 * screenshot step is subject to visual regression (with or without a baseline: the app reports `created` and
 * the render conditions), `a11y-snapshot-v1` for an environment comparison child. Comparison children skip
 * visual regression.
 */
export function screenQualityCapabilities(input: { steps: { action: string }[]; comparisonChild: boolean }): string[] {
  const needed: string[] = [SCREEN_FEATURES.masking];
  if (input.comparisonChild) needed.push(SCREEN_FEATURES.a11ySnapshot);
  else if (input.steps.some((s) => s.action === "screenshot")) needed.push(SCREEN_FEATURES.visualCompare);
  return needed;
}
