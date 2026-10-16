// Failure-time DOM summary (stage 6 contract section 8): what the page looked like when a step failed, for the
// AI diagnosis. Built in the page from structure only — no input values, no data-* attributes, nothing from
// password or card fields — then masked here with the run's secret values and personal-data patterns, and cut
// to 8KB. Unlike a trace it is made even when the run uses secret variables: it never holds what was typed,
// and what the page shows is masked before it leaves the runner.
/// <reference lib="dom" />
import { DOM_SUMMARY_MAX_BYTES, maskSecrets, redactText } from "@defe2end/shared";
import type { Page } from "playwright";

/**
 * Collected in the page; self-contained (no outer references). Text is returned as the page has it — no whitespace
 * folding and no short cut — because the run's secrets are matched against it first (`domSummary`); folding or
 * cutting before that would let a secret slip past as a changed or partial copy. A field too long to carry is left
 * out whole rather than cut.
 */
export function collectDomSummary(selector: string | null): string[] {
  const RAW_MAX = 50_000;
  const LIST_MAX = 25;
  const clip = (s: string | null | undefined) => {
    const t = s ?? "";
    return t.length > RAW_MAX ? "[long text left out]" : t;
  };
  const pathOf = (href: string | null) => {
    if (!href) return "";
    try {
      const u = new URL(href, location.href);
      return u.origin === location.origin ? u.pathname : `${u.origin}${u.pathname}`;
    } catch {
      return "";
    }
  };
  const sensitive = (el: Element) => {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    const auto = (el.getAttribute("autocomplete") ?? "").toLowerCase();
    return type === "password" || auto.startsWith("cc-") || auto.includes(" cc-") || auto === "current-password" || auto === "new-password" || auto === "one-time-code";
  };
  const isField = (el: Element) => ["input", "textarea", "select"].includes(el.tagName.toLowerCase()) || el.hasAttribute("contenteditable");
  const nameOf = (el: Element) => {
    const aria = el.getAttribute("aria-label") ?? el.getAttribute("alt") ?? el.getAttribute("title");
    if (aria) return clip(aria);
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return clip(label.textContent);
    }
    // A field's text is its value (textarea, contenteditable): never read it.
    return isField(el) ? "" : clip((el as HTMLElement).innerText ?? el.textContent);
  };
  const describe = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (isField(el) && sensitive(el)) return `<${tag} type=${(el.getAttribute("type") ?? "text").toLowerCase()} [sensitive field]>`;
    const parts = [tag];
    const role = el.getAttribute("role");
    if (role) parts.push(`role=${role}`);
    for (const attr of ["id", "name", "type", "placeholder"]) {
      const v = el.getAttribute(attr);
      if (v) parts.push(`${attr}=${clip(v)}`);
    }
    if (tag === "a") parts.push(`href=${pathOf(el.getAttribute("href"))}`);
    if (tag === "form") parts.push(`action=${pathOf(el.getAttribute("action"))}`);
    if (el instanceof HTMLElement && el.hidden) parts.push("hidden");
    if ((el as HTMLButtonElement).disabled) parts.push("disabled");
    const name = nameOf(el);
    return `<${parts.join(" ")}>${name ? ` "${name}"` : ""}`;
  };
  const list = (title: string, query: string) => {
    const found = [...document.querySelectorAll(query)].slice(0, LIST_MAX);
    return found.length ? [`## ${title}`, ...found.map(describe)] : [];
  };

  const lines = [`# ${clip(document.title)}`, `path: ${location.pathname}`];
  if (selector) {
    lines.push(`## Failed selector: ${clip(selector)}`);
    let target: Element | null = null;
    try {
      target = document.querySelector(selector);
    } catch {
      lines.push("(not a CSS selector; nearby elements unknown)");
    }
    if (target) {
      lines.push(`target: ${describe(target)}`);
      if (target.parentElement) lines.push(`parent: ${describe(target.parentElement)}`);
      for (const sib of [...(target.parentElement?.children ?? [])].filter((c) => c !== target).slice(0, 8)) lines.push(`sibling: ${describe(sib)}`);
    } else lines.push("target: (no match)");
  }
  lines.push(...list("Headings", "h1, h2, h3"));
  lines.push(...list("Landmarks", "header, nav, main, aside, footer, [role=banner], [role=navigation], [role=main], [role=dialog], [role=alert]"));
  lines.push(...list("Forms and fields", "form, input:not([type=hidden]), select, textarea"));
  lines.push(...list("Buttons", "button, [role=button], input[type=submit], input[type=button]"));
  lines.push(...list("Links", "a[href]"));
  return lines;
}

/** Cuts to `maxBytes` of UTF-8 without splitting a character. */
export function clipUtf8(text: string, maxBytes = DOM_SUMMARY_MAX_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const marker = "\n… (cut)";
  let end = maxBytes - Buffer.byteLength(marker);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + marker;
}

const FIELD_MAX = 60;
const LINE_MAX = 240;

/** Cuts quoted names to 60 characters and each line to 240, after masking. */
export function shortenFields(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const quoted = line.replace(/"([^"\n]*)"/g, (m, inner: string) => (inner.length > FIELD_MAX ? `"${inner.slice(0, FIELD_MAX)}…"` : m));
      return quoted.length > LINE_MAX ? `${quoted.slice(0, LINE_MAX)}…` : quoted;
    })
    .join("\n");
}

const fold = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The masked, clipped summary of `page`. Order matters: the run's secrets are replaced in the raw text first, then
 * whitespace is folded, then personal-data patterns, then the short cuts.
 */
export async function domSummary(page: Page, selector: string | null, secrets: readonly string[]): Promise<string> {
  const lines = await page.evaluate(collectDomSummary, selector);
  // The page's rendered text (innerText) already folds whitespace, so a secret with runs of spaces is matched
  // both as written and folded.
  const folded = secrets.map(fold).filter((v) => v.length > 0);
  const masked = lines.map((line) => maskSecrets(fold(maskSecrets(line, secrets)), folded)).join("\n");
  return clipUtf8(shortenFields(redactText(masked)));
}
