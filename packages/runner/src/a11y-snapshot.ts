// Accessibility snapshot of an environment comparison's screenshot step (stage 7 contract section 6), hidden
// in this order before anything else touches it: (1) the masked nodes, the outside elements naming or
// describing them, and their labels leave the accessibility tree for the capture only (open shadow roots
// included; always put back); (2) input values are dropped; (3) the run's secret values; (4) `redactText`.
// If (1) can't finish in time or can't hide a node, there is no snapshot at all.
import { maskSecrets, redactText } from "@defe2end/shared";
import type { Page } from "playwright";
import { MASK_ATTR, MASK_INPUT_ATTR } from "./masking.js";

export const A11Y_CAPTURE_BUDGET_MS = 3_000;
const MARK = "data-defe2end-a11y-hidden";

export type A11ySnapshotResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Hidden whatever the settings: what the page's masking marked (site selectors, automatic detection) and the
 * password and card fields — the same areas the screenshot covers.
 */
const ALWAYS_HIDDEN = [`[${MASK_ATTR}]`, `[${MASK_INPUT_ATTR}]`, 'input[type="password"]', 'input[autocomplete^="cc-"]', 'input[autocomplete="card-number"]'];

/** Card numbers and resident registration numbers, as the page's automatic detection finds them. */
const NUMBER_PATTERNS = [/\b\d(?:[ -]?\d){12,18}\b/g, /\b\d{6}[\s-]?[1-8]\d{6}\b/g];
export const REDACTED_NUMBER = "[number]";

/** Snapshot only: `redactText` leaves these numbers alone (its other users keep them). */
export function redactNumbers(text: string): string {
  let out = text;
  for (const re of NUMBER_PATTERNS) out = out.replace(re, (m) => (m.replace(/\D/g, "").length <= 8 ? m : REDACTED_NUMBER));
  return out;
}

/** Inputs whose value would otherwise appear after the colon (`- textbox "Email": mina@…`). */
const VALUE_ROLES = /^(\s*- (?:textbox|searchbox|combobox|spinbutton|slider)\b[^:]*?)(?::\s.*)?$/;

/** Drops the values of input elements; their names stay. */
export function dropInputValues(snapshot: string): string {
  return snapshot
    .split("\n")
    .map((line) => {
      const m = VALUE_ROLES.exec(line);
      if (!m) return line;
      // A trailing `:` that opens children stays (`- combobox "Size":` followed by options).
      return line.trimEnd().endsWith(":") && !/:\s\S/.test(line) ? line : m[1]!;
    })
    .join("\n");
}

async function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `selectors`: the same masking targets as the screenshot (site selectors, step `mask`); password and card
 * fields are always added. `secrets`: the run's secret values, session values included.
 */
export async function captureA11ySnapshot(page: Page, opts: { selectors: string[]; secrets: Iterable<string>; budgetMs?: number }): Promise<A11ySnapshotResult> {
  const budget = opts.budgetMs ?? A11Y_CAPTURE_BUDGET_MS;
  const started = Date.now();
  try {
    const result = await withBudget(page.evaluate(hideInPage, { selectors: [...opts.selectors, ...ALWAYS_HIDDEN], mark: MARK }), budget);
    if (!result.ok) return { ok: false, reason: result.reason };
    const left = budget - (Date.now() - started);
    if (left <= 0) return { ok: false, reason: "masking took too long" };
    const raw = await page.locator("body").ariaSnapshot({ timeout: left });
    return { ok: true, text: redactNumbers(redactText(maskSecrets(dropInputValues(raw), opts.secrets))) };
  } catch (err) {
    return { ok: false, reason: `masking failed: ${(err as Error).message.split("\n")[0]}` };
  } finally {
    // Always put the tree back, even after a failure or a timeout (the evaluate may still have run).
    await page.evaluate(restoreInPage, MARK).catch(() => {});
  }
}

/** Runs in the page. Marks every node it hides with the previous `aria-hidden` so the restore is exact. */
function hideInPage({ selectors, mark }: { selectors: string[]; mark: string }): { ok: true } | { ok: false; reason: string } {
  const roots: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < roots.length; i++) {
    for (const el of Array.from(roots[i]!.querySelectorAll("*"))) if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  const all = selectors;
  const targets = new Set<Element>();
  for (const root of roots) {
    for (const sel of all) {
      try {
        for (const el of Array.from(root.querySelectorAll(sel))) targets.add(el);
      } catch {
        return { ok: false, reason: `invalid selector: ${sel}` };
      }
    }
  }
  const ids = new Set<string>();
  for (const t of targets) {
    if (t.id) ids.add(t.id);
    for (const d of Array.from(t.querySelectorAll("[id]"))) ids.add(d.id);
  }
  const hide = new Set<Element>(targets);
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll("[aria-labelledby],[aria-describedby],label[for]"))) {
      const refs = [...(el.getAttribute("aria-labelledby") ?? "").split(/\s+/), ...(el.getAttribute("aria-describedby") ?? "").split(/\s+/), el.getAttribute("for") ?? ""];
      if (refs.some((r) => r && ids.has(r))) hide.add(el);
    }
    // A label wrapping a hidden control names it too.
    for (const label of Array.from(root.querySelectorAll("label"))) if ([...targets].some((t) => label.contains(t))) hide.add(label);
  }
  for (const el of hide) {
    if (el.hasAttribute(mark)) continue;
    el.setAttribute(mark, el.getAttribute("aria-hidden") ?? "");
    el.setAttribute("aria-hidden", "true");
    if (el.getAttribute("aria-hidden") !== "true") return { ok: false, reason: "a masked element could not be hidden" };
  }
  return { ok: true };
}

function restoreInPage(mark: string): void {
  const roots: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < roots.length; i++) {
    for (const el of Array.from(roots[i]!.querySelectorAll("*"))) if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll(`[${mark}]`))) {
      const previous = el.getAttribute(mark);
      if (previous) el.setAttribute("aria-hidden", previous);
      else el.removeAttribute("aria-hidden");
      el.removeAttribute(mark);
    }
  }
}
