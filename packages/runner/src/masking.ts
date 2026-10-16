// Page masking (stage 7 contract section 5). A script put into every document of the context before the first
// navigation blurs what is to be hidden and turns input text into dots, without touching DOM text or values.
// Right before a capture the same script runs once more on every frame, and the capture covers the hidden areas
// with solid boxes. When that pass can't be confirmed, nothing is captured.
import { MASKING_POLICY_VERSION, splitSelectorList, type MaskingSettings } from "@defe2end/shared";
import type { Frame, Locator, Page } from "playwright";

/** Attribute the page script puts on hidden elements; its value says why (`site`, `auto`, `field`). */
export const MASK_ATTR = "data-defe2end-mask";
/** Attribute on inputs and text areas whose text shows as dots. */
export const MASK_INPUT_ATTR = "data-defe2end-mask-input";
/** Longest wait for the forced pass on one frame before the capture is refused. */
export const FORCE_PASS_TIMEOUT_MS = 3_000;

export const DEFAULT_MASKING: MaskingSettings = { enabled: true, selectors: [], policyVersion: MASKING_POLICY_VERSION };

export const MASKING_FAILED_MESSAGE = "Masking could not be applied, so the screenshot was not taken";

/** What the page script hides on its own. The scenario switch turns `selectors` and `auto` off, never `fields`. */
interface PageMaskConfig {
  selectors: string[];
  auto: boolean;
}

/** Runs in the page. Installs once per document; `force` runs both passes now and reports selector errors. */
function installPageMask(config: PageMaskConfig): void {
  const KEY = "__defe2endMask";
  const g = globalThis as unknown as Record<string, unknown>;
  if (g[KEY]) return;
  const ATTR = "data-defe2end-mask";
  const INPUT_ATTR = "data-defe2end-mask-input";
  const FIELDS = 'input[type="password"], input[autocomplete^="cc-"], input[autocomplete="card-number"]';
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE"]);
  const MAX_NODES = 4000;
  const MAX_NODE_CHARS = 3000;
  const DEBOUNCE_MS = 100;
  const MAX_DELAY_MS = 300;
  const PATTERNS = [
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    // Korean numbers (010-1234-5678, 02-123-4567) and international ones (+82 10 1234 5678).
    /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,3}/g,
    /\b0\d{1,2}[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g,
    // Card numbers and resident registration numbers.
    /\b\d(?:[ -]?\d){12,18}\b/g,
    /\b\d{6}[\s-]?[1-8]\d{6}\b/g,
  ];
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`[${ATTR}]{filter:blur(10px)!important}[${INPUT_ATTR}]{-webkit-text-security:disc!important}`);
  const roots = new Set<Document | ShadowRoot>();

  const looksPersonal = (text: string): boolean => {
    for (const [i, re] of PATTERNS.entries()) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        // Short digit runs (prices, dates, counts) are never personal data on their own. Emails (pattern 0)
        // are always hidden, digits or not.
        if (i > 0 && m[0].replace(/\D/g, "").length <= 8) continue;
        return true;
      }
    }
    return false;
  };
  const mark = (el: Element, why: string) => {
    if (el.getAttribute(ATTR) === null) el.setAttribute(ATTR, why);
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.getAttribute(INPUT_ATTR) === null) el.setAttribute(INPUT_ATTR, "");
  };
  const adopt = (root: Document | ShadowRoot) => {
    if (roots.has(root)) return;
    roots.add(root);
    try {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch {
      /* a document without style support keeps its marks for the capture boxes */
    }
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  /** Every open shadow root under `root`, found now (they can be attached at any time). */
  const collectRoots = (root: Document | ShadowRoot) => {
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) {
      adopt(el.shadowRoot);
      collectRoots(el.shadowRoot);
    }
  };
  const selectorPass = (extra: string[] = []) => {
    collectRoots(document);
    for (const root of roots) {
      for (const el of root.querySelectorAll(FIELDS)) mark(el, "field");
      for (const sel of [...config.selectors, ...extra]) for (const el of root.querySelectorAll(sel)) mark(el, "site");
    }
  };
  const autoPass = () => {
    if (!config.auto) return;
    let seen = 0;
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && seen < MAX_NODES; node = walker.nextNode()) {
        seen++;
        const parent = node.parentElement;
        const text = node.nodeValue ?? "";
        if (!parent || SKIP.has(parent.tagName) || text.length > MAX_NODE_CHARS || text.trim().length < 6) continue;
        if (looksPersonal(text)) mark(parent, "auto");
      }
      for (const el of root.querySelectorAll("input, textarea")) {
        const value = (el as HTMLInputElement).value;
        if (value && value.length <= MAX_NODE_CHARS && looksPersonal(value)) mark(el, "auto");
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingSince = 0;
  const scheduleAuto = () => {
    if (!config.auto) return;
    const now = Date.now();
    if (timer === undefined) pendingSince = now;
    else clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      autoPass();
    }, Math.max(0, Math.min(DEBOUNCE_MS, pendingSince + MAX_DELAY_MS - now)));
  };
  const onChange = () => {
    try {
      selectorPass();
    } catch {
      /* an invalid selector is reported by the forced pass before a capture */
    }
    scheduleAuto();
  };
  const observer = new MutationObserver((records) => {
    if (records.every((r) => r.type === "attributes" && (r.attributeName === ATTR || r.attributeName === INPUT_ATTR))) return;
    onChange();
  });
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = attach.call(this, init);
    if (init.mode === "open") queueMicrotask(onChange);
    return root;
  };
  const start = () => {
    adopt(document);
    onChange();
  };
  document.addEventListener("input", onChange, true);
  if (document.documentElement) start();
  else document.addEventListener("readystatechange", start, { once: true });

  Object.defineProperty(g, KEY, {
    value: {
      force(extra: string[]): { error?: string } {
        try {
          adopt(document);
          selectorPass(extra);
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          autoPass();
          return {};
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    enumerable: false,
  });
}

/** The init script for the context: every page, popup and frame gets it before its own scripts run. */
export function pageMaskScript(settings: MaskingSettings): string {
  return `(${installPageMask.toString()})(${JSON.stringify(pageMaskConfig(settings))});`;
}

function pageMaskConfig(settings: MaskingSettings): PageMaskConfig {
  return settings.enabled ? { selectors: settings.selectors, auto: true } : { selectors: [], auto: false };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Runs the masking pass now on every frame of `page` (spec 2.11 and the capture), installing the script where
 * it is missing. Returns why it failed; a frame of another origin that can't be reached is not a failure
 * (documented as not masked).
 */
export async function forceMask(page: Page, settings: MaskingSettings, extra: string[] = []): Promise<string | null> {
  const config = pageMaskConfig(settings);
  const mainUrl = page.url();
  for (const frame of page.frames()) {
    const required = frame === page.mainFrame() || sameOrigin(frame.url(), mainUrl) || frame.url() === "about:blank";
    let result: { error?: string } | "missing";
    try {
      result = await withTimeout(runForce(frame, config, extra), FORCE_PASS_TIMEOUT_MS);
    } catch (err) {
      if (frame.isDetached()) continue;
      if (!required) continue;
      return err instanceof Error ? err.message.split("\n")[0]! : String(err);
    }
    if (result === "missing") return "the masking script could not be installed";
    if (result.error) return result.error;
  }
  return null;
}

async function runForce(frame: Frame, config: PageMaskConfig, extra: string[]): Promise<{ error?: string } | "missing"> {
  return frame.evaluate(
    ({ source, config, extra }) => {
      const g = globalThis as unknown as Record<string, { force(extra: string[]): { error?: string } } | undefined>;
      // The first page's initial empty document runs no init script; install it here.
      if (!g.__defe2endMask) (0, eval)(`(${source})(${JSON.stringify(config)})`);
      const api = g.__defe2endMask;
      return api ? api.force(extra) : ("missing" as const);
    },
    { source: installPageMask.toString(), config, extra },
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the masking pass timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Solid boxes for the capture: everything the page marked, in every frame, plus the step's own `mask`. */
function coverLocators(page: Page, stepMask: string[]): Locator[] {
  const out: Locator[] = [];
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    out.push(frame.locator(`[${MASK_ATTR}]`));
    for (const sel of stepMask) out.push(frame.locator(sel));
  }
  return out;
}

export type MaskedCapture = { ok: true; png: Buffer } | { ok: false; reason: string };

/**
 * The one way the runner takes a picture of a page: masking pass on every frame, then a capture with solid
 * boxes over the masked areas (site selectors, automatic detection, password and card fields, `stepMask` and
 * `extra`). When the pass fails, nothing is captured. The caller decides what a refusal means for the step.
 */
export async function captureMasked(page: Page, opts: { settings: MaskingSettings; stepMask?: string; extra?: Locator[] }): Promise<MaskedCapture> {
  const stepMask = splitSelectorList(opts.stepMask ?? "");
  const failed = await forceMask(page, opts.settings, stepMask).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
  if (failed) return { ok: false, reason: failed };
  const png = await page.screenshot({ mask: [...coverLocators(page, stepMask), ...(opts.extra ?? [])], animations: "disabled", timeout: 10_000 });
  return { ok: true, png };
}
