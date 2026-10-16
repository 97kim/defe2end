// In-page half of the recorder (desktop spec 5.2): selector candidates, re-ranking by match count and the
// actionable target. Runs in the tab (preload) and in tests via `page.evaluate`, so `recorderDom` is one
// self-contained function: no imports and no references outside its body.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { ElementInfo } from "./index.js";

export interface RecorderDom {
  /** Nearest actionable ancestor (or the element itself). */
  actionable(el: Element): Element;
  /** Candidates in build order, before re-ranking. */
  candidates(el: Element, testAttributes: readonly string[]): string[];
  /** Candidates re-ranked by how many elements they match in `doc`. */
  rank(candidates: readonly string[], doc: Document): string[];
  describe(el: Element, testAttributes: readonly string[]): ElementInfo;
}

export function recorderDom(): RecorderDom {
  const ACTIONABLE = "a, button, [role=button], [role=link], [role=tab], [role=option], [role=menuitem], input, select, textarea, label, [onclick]";
  const STATE_PIECES = new Set(["active", "hover", "focus", "focused", "selected", "checked", "current", "open", "opened", "expanded", "collapsed", "disabled", "highlight", "highlighted"]);
  const ROLE_NAME_MAX = 30;
  const TEXT_MAX = 25;
  const NAME_MAX = 40;
  const HREF_MAX = 80;
  const OVERLAY_Z = 1000;

  const collapse = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const tag = (el: Element) => el.tagName.toLowerCase();

  function roleOf(el: Element): string | undefined {
    const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const t = tag(el);
    if (t === "a" && el.hasAttribute("href")) return "link";
    if (t === "button") return "button";
    if (t === "input" && ["button", "submit", "reset", "image"].includes((el.getAttribute("type") ?? "").toLowerCase())) return "button";
    if (/^h[1-6]$/.test(t)) return "heading";
    return undefined;
  }

  function labelOf(el: Element): string {
    return collapse(el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title"));
  }

  /** Name for the role candidate: label attributes, else short text without controls inside, else a card link's title. */
  function roleName(el: Element): string | undefined {
    const label = labelOf(el);
    if (label) return label;
    if (tag(el) === "input") return collapse((el as HTMLInputElement).value) || undefined;
    const text = collapse(el.textContent);
    if (text && text.length <= ROLE_NAME_MAX && !el.querySelector(ACTIONABLE)) return text;
    if (roleOf(el) === "link") {
      const title = el.querySelector("h1, h2, h3, h4, h5, h6, [class*=title], [class*=Title]");
      const t = collapse(title?.textContent);
      if (t && t.length <= ROLE_NAME_MAX) return t;
    }
    return undefined;
  }

  /** Accessible name (whitespace-collapsed), used for `text=` and display. */
  function accessibleName(el: Element): string {
    const label = labelOf(el);
    if (label) return label;
    if (tag(el) === "input") {
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return collapse((el as HTMLInputElement).value);
      return "";
    }
    return collapse(el.textContent);
  }

  function dynamicId(id: string): boolean {
    const head = /^[A-Za-z0-9_-]+/.exec(id)?.[0] ?? "";
    return /\d{4,}/.test(head);
  }

  function stableClass(c: string): boolean {
    if (c.length < 3) return false;
    if (/^(sc-|css-|jsx-)/.test(c)) return false;
    const pieces = c.split(/[-_]+/).filter(Boolean);
    if (pieces.some((p) => STATE_PIECES.has(p.toLowerCase()))) return false;
    if (pieces.some((p) => /[a-zA-Z]\d|\d[a-zA-Z]/.test(p))) return false;
    if (/^[a-zA-Z]{3,8}$/.test(c) && /[a-z]/.test(c) && /[A-Z]/.test(c)) return false;
    if (/^[b-df-hj-np-tv-z]{4,10}$/.test(c)) return false;
    return true;
  }

  function trackingUrl(href: string): boolean {
    let url: URL;
    try {
      url = new URL(href, location.href);
    } catch {
      return false;
    }
    const host = url.hostname.toLowerCase();
    if (/(^|\.)(googleadservices\.com|doubleclick\.net)$/.test(host)) return true;
    if (/(^|\.)google\.[a-z.]+$/.test(host) && /^\/(aclk|url|pagead)(\/|$)/.test(url.pathname)) return true;
    return url.searchParams.has("gclid") || url.searchParams.has("fbclid");
  }

  function hrefCandidates(el: Element): string[] {
    const href = el.getAttribute("href") ?? "";
    if (href.length < 2 || /^javascript/i.test(href) || trackingUrl(href)) return [];
    const clean = (s: string) => s.slice(0, HREF_MAX).replace(/"/g, "");
    const out: string[] = [];
    const path = href.split(/[?#]/)[0]!;
    let pathOnly = path;
    try {
      pathOnly = /^[a-z][a-z0-9+.-]*:/i.test(path) ? new URL(path).pathname : path;
    } catch {
      // Keep the raw path.
    }
    if (path && pathOnly !== "/" && path !== href) out.push(`a[href*="${clean(path)}"]`);
    const whole = `a[href*="${clean(href)}"]`;
    if (!out.includes(whole)) out.push(whole);
    return out;
  }

  function candidates(el: Element, testAttributes: readonly string[]): string[] {
    const t = tag(el);
    const out: string[] = [];
    const add = (s: string) => {
      if (s && !out.includes(s)) out.push(s);
    };
    const role = roleOf(el);
    if (role === "link" || role === "button" || role === "heading") {
      const name = roleName(el);
      if (name && !name.includes(")")) add(`${role}(${name})`);
    }
    const id = el.getAttribute("id");
    if (id && !dynamicId(id)) add(`#${CSS.escape(id)}`);
    const testId = el.getAttribute("data-testid");
    if (testId) add(`[data-testid="${quote(testId)}"]`);
    for (const attr of testAttributes) {
      const v = el.getAttribute(attr);
      if (v !== null) {
        add(`${t}[${attr}="${quote(v)}"]`);
        break;
      }
    }
    const name = el.getAttribute("name");
    if (name) add(`${t}[name="${quote(name)}"]`);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) add(`input[placeholder="${quote(placeholder)}"]`);
    if (t === "a") for (const h of hrefCandidates(el)) add(h);
    const classes = [...el.classList].filter(stableClass).sort((a, b) => b.length - a.length);
    if (classes[0]) add(`${t}.${CSS.escape(classes[0])}`);
    if (classes[1]) add(`${t}.${CSS.escape(classes[0]!)}.${CSS.escape(classes[1])}`);
    const text = accessibleName(el).slice(0, NAME_MAX);
    if (text && (text.length <= TEXT_MAX || out.length === 0)) add(`text=${text}`);
    // Never keep the typed value of a password field in a selector.
    if (t === "input" && (el.getAttribute("type") ?? "").toLowerCase() === "password") {
      const value = (el as HTMLInputElement).value;
      if (value) return out.filter((s) => !s.includes(value));
    }
    return out;
  }

  /** Number of matches, or undefined when it can't be counted (`text=`). Role candidates match exactly. */
  function countMatches(selector: string, doc: Document): number | undefined {
    if (selector.startsWith("text=")) return undefined;
    const role = /^(link|button|heading)\((.*)\)$/s.exec(selector);
    if (role) {
      const want = collapse(role[2]).toLowerCase();
      let n = 0;
      for (const el of doc.querySelectorAll("*")) if (roleOf(el) === role[1] && collapse(roleName(el)).toLowerCase() === want) n++;
      return n;
    }
    try {
      return doc.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  }

  function rank(list: readonly string[], doc: Document): string[] {
    const grade = (s: string) => {
      const n = countMatches(s, doc);
      return n === undefined || n === 1 ? 0 : n > 1 ? 1 : 2;
    };
    return list
      .map((s, i) => ({ s, i, g: grade(s) }))
      .sort((a, b) => a.g - b.g || a.i - b.i)
      .map((x) => x.s);
  }

  function actionable(el: Element): Element {
    return el.closest(ACTIONABLE) ?? el;
  }

  function inOverlay(el: Element): boolean {
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      const style = getComputedStyle(cur);
      if ((style.position === "fixed" || style.position === "sticky") && Number(style.zIndex) >= OVERLAY_Z) return true;
    }
    return false;
  }

  function describe(el: Element, testAttributes: readonly string[]): ElementInfo {
    const info: ElementInfo = { selectors: rank(candidates(el, testAttributes), el.ownerDocument), tagName: tag(el) };
    const type = el.getAttribute("type");
    if (type) info.type = type.toLowerCase();
    const role = roleOf(el);
    if (role) info.role = role;
    const text = accessibleName(el).slice(0, 80);
    if (text && !(tag(el) === "input" && info.type === "password")) info.text = text;
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) info.placeholder = placeholder;
    if (inOverlay(el)) info.inOverlay = true;
    return info;
  }

  return { actionable, candidates, rank, describe };
}

export { DIALOG_WRAPPER_SOURCE, installCollector, type Collector, type CollectorOptions, type RecorderState } from "./collect.js";
