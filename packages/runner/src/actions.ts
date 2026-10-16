import {
  parseJsonLdCondition,
  parseUploadToken,
  parseUrlPattern,
  uploadTokens,
  urlPatternMatches,
  wildcardMatch,
  type JsonLdSegment,
  type Step,
  type StepErrorCode,
} from "@defe2end/shared";
import { errors, type Dialog, type ElementHandle, type Frame, type FrameLocator, type Locator, type Page } from "playwright";
import { downloadFile } from "./download.js";
import { isBlockedUrl, type NetworkRules } from "./network.js";
import { ResponseLog, type RunSession } from "./session.js";

/** A step that did not pass, with what the result screen shows. Messages are masked by the caller. */
export class StepFailure extends Error {
  constructor(
    readonly code: StepErrorCode | undefined,
    message: string,
    readonly detail: { expected?: string; actual?: string } = {},
    /** `error` is infrastructure trouble: no retry, and the run stops. */
    readonly status: "failed" | "error" = "failed",
  ) {
    super(message);
  }
}

/** Ends the step as `warning` (spec 4.1): not retried, the run continues. */
export class StepWarning extends Error {}

export interface ActionContext {
  session: RunSession;
  step: Step;
  index: number;
  baseUrl: string;
  network: NetworkRules;
  timeoutMs: number;
  /** Fields after `{{KEY}}` substitution. */
  selector?: string;
  url?: string;
  value?: string;
  expected?: string;
  /** Whether `value` contains a secret. */
  valueHasSecret: boolean;
  signal: AbortSignal;
  screenshot(name: string): Promise<void>;
  /** Applies the secret masking to `page` once more right before a value goes in (spec 2.11); never throws. */
  maskBeforeInput(page: Page): Promise<void>;
  log(message: string): Promise<void>;
  /** File of an `attachment:<name>` uploadFile token; `undefined` fails the step. */
  resolveAttachment?(name: string): Promise<UploadFile | undefined>;
}

/** One file for `setInputFiles`. */
export interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

type Action = (ctx: ActionContext) => Promise<void>;

const NO_POPUP = "No popup page available. Use clickAndWaitPopup first.";

export const ACTIONS: Record<Step["action"], Action> = {
  async goto(ctx) {
    // An empty url (e.g. a variable that substituted to "") opens the base URL (spec 2.6).
    const url = resolveUrl(ctx.url ?? "", ctx.baseUrl);
    if (isBlockedUrl(url, ctx.network)) throw new StepFailure("blocked_request", `Blocked request to ${url}`);
    await ctx.session.mainPage.goto(url, { timeout: ctx.timeoutMs, waitUntil: "domcontentloaded" });
  },

  async click(ctx) {
    if (!ctx.selector) {
      // No selector (or one that substituted to ""): click the position, or pass without doing anything (spec 3.1).
      const position = ctx.step.position;
      if (position) await ctx.session.mainPage.mouse.click(position.x, position.y);
      return;
    }
    await withTarget(ctx, ctx.session.mainPage, ctx.selector, (l) => l.click({ timeout: ctx.timeoutMs }));
  },

  async fill(ctx) {
    await fillOn(ctx, ctx.session.mainPage, required(ctx.selector, "fill needs a selector"), ctx.value ?? "");
  },

  async select(ctx) {
    const wanted = ctx.value ?? "";
    await withTarget(ctx, ctx.session.mainPage, required(ctx.selector, "select needs a selector"), async (l) => {
      // Playwright's own selectOption with one "value or label" condition (spec 3.1): it retargets labels, waits for
      // the select to be actionable and for an enabled matching option, and normalizes labels itself.
      // No extra diagnosis after a timeout: it would delay the step retry and change the verdict (spec 2.9).
      await l.selectOption(wanted, { timeout: ctx.timeoutMs });
    });
  },

  async pressKey(ctx) {
    const key = required(ctx.value, "pressKey needs a key");
    if (ctx.selector) {
      await withTarget(ctx, ctx.session.mainPage, ctx.selector, async (l) => {
        const target = await secretTarget(ctx, ctx.session.mainPage, l);
        await ctx.maskBeforeInput(ctx.session.mainPage);
        await target.press(key, { timeout: ctx.timeoutMs });
      });
    } else {
      if (ctx.valueHasSecret) ctx.session.unmaskable.set(ctx.session.mainPage, "a secret was typed without a target field");
      await ctx.maskBeforeInput(ctx.session.mainPage);
      await ctx.session.mainPage.keyboard.press(key);
    }
  },

  async hover(ctx) {
    await withTarget(ctx, ctx.session.mainPage, required(ctx.selector, "hover needs a selector"), (l) => l.hover({ timeout: ctx.timeoutMs }));
  },

  async scroll(ctx) {
    const page = ctx.session.mainPage;
    if (ctx.selector) {
      await withTarget(ctx, page, ctx.selector, (l) => l.scrollIntoViewIfNeeded({ timeout: ctx.timeoutMs }));
      return;
    }
    const value = (ctx.value ?? "").trim().toLowerCase();
    if (value === "bottom") await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    else if (value === "top") await page.evaluate(() => window.scrollTo(0, 0));
    else {
      const n = Number(value);
      const dy = value !== "" && Number.isFinite(n) && n !== 0 ? n : 300;
      await page.evaluate((y) => window.scrollBy(0, y), dy);
    }
  },

  async wait(ctx) {
    await ctx.session.active.waitForTimeout(ctx.timeoutMs);
  },

  async uploadFile(ctx) {
    // URL tokens are downloaded under the block rules; `attachment:<name>` tokens (defE2End extension) come
    // from the workspace attachment pinned at request time.
    // No tokens (a value that substituted to "") sets an empty file list (spec 3.1).
    const tokens = uploadTokens(ctx.value ?? "");
    const files: UploadFile[] = [];
    for (const token of tokens) {
      const parsed = parseUploadToken(token);
      if (parsed.kind === "invalid") throw new StepFailure("invalid_step", parsed.message);
      if (parsed.kind === "url") {
        files.push(await downloadFile(parsed.url, { network: ctx.network, timeoutMs: ctx.timeoutMs, signal: ctx.signal }));
        continue;
      }
      const file = await ctx.resolveAttachment?.(parsed.name);
      if (!file) throw new StepFailure("invalid_step", `No workspace attachment named "${parsed.name}" was pinned for this run`);
      files.push(file);
    }
    // One match: that input, even hidden. Several: the first visible one, else the first (spec 3.1, 2.4).
    const { locator, exact } = await resolveTargets(ctx.session.mainPage, required(ctx.selector, "uploadFile needs a selector"));
    const pool = exact && (await exact.count()) > 0 ? exact : locator;
    const count = await pool.count();
    let pick = 0;
    for (let i = 0; count > 1 && i < count; i++) {
      if (await pool.nth(i).isVisible().catch(() => false)) {
        pick = i;
        break;
      }
    }
    if (count > 1) await ctx.log(`${count} elements match ${ctx.selector}; using element ${pick + 1}`);
    await pool.nth(pick).setInputFiles(files, { timeout: ctx.timeoutMs });
  },

  async clickFirstEnabled(ctx) {
    const selector = required(ctx.selector, "clickFirstEnabled needs a selector");
    // Every `|` piece counts, empty ones included; a piece without `:` has an empty property name (spec 3.1).
    const expected = ctx.expected ?? "";
    const rules =
      expected === ""
        ? []
        : expected.split("|").map((rule) => {
            const colon = rule.indexOf(":");
            const prop = colon < 0 ? "" : rule.slice(0, colon).trim();
            let val = (colon < 0 ? rule : rule.slice(colon + 1)).trim();
            if (val.startsWith("#") && val.length === 7) {
              const [r, g, b] = [1, 3, 5].map((i) => Number(`0x${val.slice(i, i + 2)}`));
              val = `rgb(${r}, ${g}, ${b})`;
            }
            return { prop, val };
          });
    // Plain Playwright selector: no role syntax and no multi-match rule here.
    const locator = ctx.session.mainPage.locator(selector);
    const count = await locator.count();
    for (let i = 0; i < count; i++) {
      const el = locator.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      if ((await el.getAttribute("disabled", { timeout: 2000 }).catch(() => null)) !== null) continue;
      if (rules.length > 0) {
        const active = await el
          .evaluate((node, rules) => {
            const style = getComputedStyle(node as Element);
            return rules.some((r) => (r.prop === "" ? "" : style.getPropertyValue(r.prop)).includes(r.val));
          }, rules)
          .catch(() => false);
        if (!active) continue;
      }
      try {
        await el.click({ timeout: 2000 });
        return;
      } catch {
        // Next candidate.
      }
    }
    throw new StepFailure("assertion_failed", `No enabled element found for ${selector}`);
  },

  async waitForSelector(ctx) {
    await withTarget(ctx, ctx.session.mainPage, required(ctx.selector, "waitForSelector needs a selector"), (l) => l.waitFor({ state: "visible", timeout: ctx.timeoutMs }));
  },

  async waitForUrl(ctx) {
    const expected = ctx.expected ?? "";
    const pattern = parseUrlPattern(expected);
    if (!pattern.ok) throw new StepFailure("invalid_step", pattern.message);
    const page = ctx.session.mainPage;
    if (urlPatternMatches(page.url(), pattern)) return;
    try {
      await page.waitForURL((url) => urlPatternMatches(url.href, pattern), { timeout: ctx.timeoutMs, waitUntil: "commit" });
    } catch (err) {
      if (err instanceof errors.TimeoutError) throw new StepFailure("timeout", `URL did not match ${expected}`, { expected, actual: page.url() });
      throw err;
    }
  },

  async assertVisible(ctx) {
    await visibleOn(ctx, ctx.session.mainPage);
  },

  async assertVisibleOrWarn(ctx) {
    // An empty selector can't be found, so it warns like any other miss (spec 3.2).
    const selector = ctx.selector ?? "";
    try {
      await withTarget(ctx, ctx.session.mainPage, selector, (l) => l.waitFor({ state: "visible", timeout: ctx.timeoutMs }));
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      throw new StepWarning(ctx.expected || `Element not found (warning): ${selector}`);
    }
  },

  async assertText(ctx) {
    const selector = required(ctx.selector, "assertText needs a selector");
    const expected = ctx.expected ?? "";
    await withTarget(ctx, ctx.session.mainPage, selector, async (l) => {
      await l.waitFor({ state: "attached", timeout: ctx.timeoutMs });
      const actual = (await l.textContent({ timeout: ctx.timeoutMs })) ?? "";
      if (!actual.includes(expected)) {
        throw new StepFailure("assertion_failed", `Text "${expected}" not found in ${selector} (actual: "${actual}")`, { expected, actual });
      }
    });
  },

  async assertUrl(ctx) {
    const expected = ctx.expected ?? "";
    const actual = ctx.session.mainPage.url();
    if (!wildcardMatch(actual, expected)) throw new StepFailure("assertion_failed", `URL does not match ${expected}`, { expected, actual });
  },

  async assertTitle(ctx) {
    const expected = ctx.expected ?? "";
    let actual = "";
    await poll(ctx, 250, async () => wildcardMatch((actual = await ctx.session.mainPage.title()), expected), () =>
      new StepFailure("assertion_failed", `Title does not match ${expected}`, { expected, actual }),
    );
  },

  async assertCount(ctx) {
    const selector = required(ctx.selector, "assertCount needs a selector");
    const raw = (ctx.expected ?? "").trim();
    if (!/^\d+$/.test(raw)) throw new StepFailure("invalid_step", "assertCount needs a whole number");
    const expected = Number(raw);
    const locator = await resolveLocator(ctx.session.mainPage, selector);
    let actual = 0;
    await poll(ctx, 250, async () => (actual = await locator.count()) === expected, () =>
      new StepFailure("assertion_failed", `Expected ${expected} elements matching ${selector}, found ${actual}`, { expected: String(expected), actual: String(actual) }),
    );
  },

  async assertExists(ctx) {
    const selector = required(ctx.selector, "assertExists needs a selector");
    const locator = await resolveLocator(ctx.session.mainPage, selector);
    await locator.first().waitFor({ state: "attached", timeout: ctx.timeoutMs });
  },

  async assertJsonLd(ctx) {
    const condition = parseJsonLdCondition(ctx.expected ?? "");
    if (!condition.ok) throw new StepFailure("invalid_step", condition.message);
    const selector = ctx.selector || 'script[type="application/ld+json"]';
    const locator = await resolveLocator(ctx.session.mainPage, selector);
    let blocks = 0;
    let types: string[] = [];
    let broken: string[] = [];
    await poll(ctx, 250, async () => {
      const texts = await locator.allTextContents();
      blocks = texts.length;
      const candidates: unknown[] = [];
      types = [];
      broken = [];
      texts.forEach((text, i) => {
        try {
          collectCandidates(JSON.parse(text), candidates);
        } catch {
          broken.push(`block ${i + 1}`);
        }
      });
      for (const c of candidates) if (c && typeof c === "object" && "@type" in c) types.push(String((c as Record<string, unknown>)["@type"]));
      return blocks > 0 && candidates.some((c) => jsonLdHolds(c, condition.path, condition.op, condition.value));
    }, () =>
      blocks === 0
        ? new StepFailure("assertion_failed", `no ld+json (${selector})`)
        : new StepFailure(
            "assertion_failed",
            `ld+json condition ${ctx.expected} not met in ${blocks} block(s); @type found: ${types.join(", ") || "none"}${broken.length ? `; unparsable: ${broken.join(", ")}` : ""}`,
          ),
    );
  },

  async assertResponse(ctx) {
    const pattern = ctx.expected ?? "";
    // JavaScript number conversion (spec 3.2): "2e2", "200.0", "0xC8" → 200; whitespace only → 0; not a number → NaN.
    const raw = ctx.value ?? "";
    const want = raw === "" ? 200 : Number(raw);
    // Only the first page (its iframes included): popups and other pages don't count (spec 3.2).
    const log = new ResponseLog(ctx.session.mainPage);
    try {
      let first: (typeof log.entries)[number] | undefined;
      await poll(ctx, 100, async () => (first = log.entries.find((e) => e.url.includes(pattern))) !== undefined, () =>
        new StepFailure("timeout", `No response matching ${pattern}`, { expected: String(want), actual: "no response" }),
      );
      if (first!.status !== want) throw new StepFailure("assertion_failed", `${first!.method} ${first!.url} answered ${first!.status}`, { expected: String(want), actual: String(first!.status) });
    } finally {
      log.stop();
    }
  },

  async screenshot(ctx) {
    await ctx.screenshot(ctx.step.name || "screenshot");
  },

  async clickAndWaitPopup(ctx) {
    const selector = required(ctx.selector, "clickAndWaitPopup needs a selector");
    const popup = ctx.session.context.waitForEvent("page", { timeout: ctx.timeoutMs });
    popup.catch(() => {});
    await withTarget(ctx, ctx.session.mainPage, selector, (l) => l.click({ timeout: ctx.timeoutMs }));
    let page: Page;
    try {
      page = await popup;
    } catch (err) {
      if (err instanceof errors.TimeoutError) throw new StepFailure("timeout", "No new window opened");
      throw err;
    }
    await page.waitForLoadState("domcontentloaded", { timeout: ctx.timeoutMs });
    ctx.session.popup = page;
  },

  async clickInPopup(ctx) {
    await withTarget(ctx, popupPage(ctx), required(ctx.selector, "clickInPopup needs a selector"), (l) => l.click({ timeout: ctx.timeoutMs }));
  },

  async fillInPopup(ctx) {
    await fillOn(ctx, popupPage(ctx), required(ctx.selector, "fillInPopup needs a selector"), ctx.value ?? "");
  },

  async assertVisibleInPopup(ctx) {
    await visibleOn(ctx, popupPage(ctx));
  },

  async assertPopupUrl(ctx) {
    const expected = ctx.expected ?? "";
    const actual = popupPage(ctx).url();
    if (!wildcardMatch(actual, expected)) throw new StepFailure("assertion_failed", `Popup URL does not match ${expected}`, { expected, actual });
  },

  async closePopup(ctx) {
    const popup = ctx.session.popup;
    ctx.session.popup = undefined;
    if (popup && !popup.isClosed()) await popup.close();
  },

  async clickInIframe(ctx) {
    await iframeTarget(ctx).click({ timeout: ctx.timeoutMs });
  },

  async fillInIframe(ctx) {
    const target = await secretTarget(ctx, ctx.session.mainPage, iframeTarget(ctx), ctx.expected);
    await ctx.maskBeforeInput(ctx.session.mainPage);
    await target.fill(ctx.expected ?? "", { timeout: ctx.timeoutMs });
  },

  async assertVisibleInIframe(ctx) {
    await iframeTarget(ctx).waitFor({ state: "visible", timeout: ctx.timeoutMs });
  },

  async clickAndAcceptDialog(ctx) {
    await dialogStep(ctx, async (dialog) => {
      await dialog.accept();
      return undefined;
    });
  },

  async clickAndDismissDialog(ctx) {
    await dialogStep(ctx, async (dialog) => {
      if (dialog.type() === "alert") {
        await dialog.accept();
        return "alert can't be dismissed; use clickAndAcceptDialog";
      }
      await dialog.dismiss();
      return undefined;
    });
  },

  async clickAndSubmitPrompt(ctx) {
    const text = ctx.value ?? "";
    await dialogStep(ctx, async (dialog) => {
      if (dialog.type() !== "prompt") {
        await dialog.dismiss();
        return `expected a prompt, got ${dialog.type()}`;
      }
      await dialog.accept(text);
      return undefined;
    });
  },
};

// ---- selectors (spec 2.3, 2.4) ----

const ROLES = new Set(
  "alert banner button cell checkbox columnheader combobox dialog form grid gridcell heading img link list listbox listitem main navigation option radio region row rowheader searchbox separator slider spinbutton strong tab tablist tabpanel textbox toolbar tree treeitem".split(
    " ",
  ),
);
/** Roles that are also tag names: alone they are tag selectors. */
const TAG_ROLES = new Set(["button", "cell", "dialog", "form", "img", "link", "list", "main", "option", "strong"]);

type RolePart = { role: string; name?: string };

/** The role syntax, or undefined when any `>>` part is not `role` / `role(name)` (spec 2.3). */
export function parseRoleSelector(selector: string): RolePart[] | undefined {
  const parts = selector.split(">>").map((p) => p.trim());
  const out: RolePart[] = [];
  for (const part of parts) {
    const m = /^([a-z]+)(?:\(([\s\S]*)\))?$/.exec(part);
    if (!m || !ROLES.has(m[1]!)) return undefined;
    if (m[2] === undefined && TAG_ROLES.has(m[1]!)) return undefined;
    // Empty parentheses `role()` mean no name; whitespace-only parentheses still name the part.
    out.push(m[2] === undefined || m[2] === "" ? { role: m[1]! } : { role: m[1]!, name: m[2] });
  }
  return out;
}

type Root = Page | Frame | FrameLocator | Locator;

function exactName(name: string): RegExp {
  const words = name.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  return new RegExp(`^\\s*${words.join("\\s+")}\\s*$`, "i");
}

function buildRole(root: Root, parts: RolePart[], exact: boolean): Locator {
  let current: Root = root;
  parts.forEach((part) => {
    // The exact variant makes every named part exact; unnamed parts match by role only (spec 2.3).
    const name = part.name === undefined ? undefined : exact ? exactName(part.name) : part.name;
    current = (current as Page).getByRole(part.role as Parameters<Page["getByRole"]>[0], name === undefined ? {} : { name });
  });
  return current as Locator;
}

/** Candidate locator for a selector: the exact-name match when the role syntax has a name and one exists. */
export async function resolveTargets(root: Root, selector: string): Promise<{ locator: Locator; exact?: Locator }> {
  const role = parseRoleSelector(selector);
  if (!role) return { locator: (root as Page).locator(selector) };
  const locator = buildRole(root, role, false);
  if (role.every((part) => part.name === undefined)) return { locator };
  return { locator, exact: buildRole(root, role, true) };
}

async function resolveLocator(root: Root, selector: string): Promise<Locator> {
  return (await resolveTargets(root, selector)).locator;
}

/**
 * Runs `op` on the target with the multi-match rule of spec 2.4: exact matches first; when several match,
 * retry once on the first visible element of the pool instead of failing.
 */
async function withTarget<T>(ctx: ActionContext, root: Root, selector: string, op: (l: Locator) => Promise<T>): Promise<T> {
  const { locator, exact } = await resolveTargets(root, selector);
  const candidate = exact && (await exact.count()) > 0 ? exact : locator;
  try {
    return await op(candidate);
  } catch (err) {
    if (!/strict mode violation/i.test(firstLine(err))) throw err;
    const pool = exact && (await exact.count()) > 0 ? exact : candidate;
    const count = await pool.count();
    let pick = 0;
    for (let i = 0; i < count; i++) {
      if (await pool.nth(i).isVisible().catch(() => false)) {
        pick = i;
        break;
      }
    }
    await ctx.log(`${count} elements match ${selector}; using element ${pick + 1}`);
    return op(pool.nth(pick));
  }
}

async function visibleOn(ctx: ActionContext, page: Page): Promise<void> {
  const selector = required(ctx.selector, `${ctx.step.action} needs a selector`);
  await withTarget(ctx, page, selector, (l) => l.waitFor({ state: "visible", timeout: ctx.timeoutMs }));
}

async function fillOn(ctx: ActionContext, page: Page, selector: string, value: string): Promise<void> {
  await withTarget(ctx, page, selector, async (l) => {
    const target = await secretTarget(ctx, page, l);
    await ctx.maskBeforeInput(page);
    await target.fill(value, { timeout: ctx.timeoutMs });
  });
}

function popupPage(ctx: ActionContext): Page {
  const popup = ctx.session.popup;
  if (!popup || popup.isClosed()) throw new StepFailure("no_popup", NO_POPUP);
  return popup;
}

/** Inner element of an iframe path `a >>> b` (spec 2.7); strict: several matches fail. */
function iframeTarget(ctx: ActionContext): Locator {
  const path = (ctx.selector ?? "")
    .split(">>>")
    .map((p) => p.trim())
    .filter(Boolean);
  // An empty path finds no frame, so the step waits out its timeout and fails (spec 3.4).
  if (path.length === 0) path.push("defe2end-no-iframe-path");
  const inner = required(ctx.value, `${ctx.step.action} needs an inner element selector`);
  let frame: FrameLocator = ctx.session.mainPage.frameLocator(path[0]!);
  for (const part of path.slice(1)) frame = frame.frameLocator(part);
  return frame.locator(inner);
}

/** Dialog actions (spec 2.8): own handler → click → wait for the dialog; the default handler comes back after. */
async function dialogStep(ctx: ActionContext, handle: (dialog: Dialog) => Promise<string | undefined>): Promise<void> {
  const selector = required(ctx.selector, `${ctx.step.action} needs a selector`);
  let result: { kindError?: string; message: string } | undefined;
  let wake: () => void = () => {};
  const seen = new Promise<void>((resolve) => (wake = resolve));
  ctx.session.dialogHandler = async (dialog) => {
    if (result) return dialog.accept();
    const message = dialog.message();
    const kindError = await handle(dialog);
    result = { message, ...(kindError ? { kindError } : {}) };
    wake();
  };
  try {
    // The prompt text goes in while the dialog blocks the page, so the masking pass runs before the click.
    if (ctx.step.action === "clickAndSubmitPrompt") await ctx.maskBeforeInput(ctx.session.mainPage);
    await withTarget(ctx, ctx.session.mainPage, selector, (l) => l.click({ timeout: ctx.timeoutMs }));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([seen, new Promise<void>((resolve) => (timer = setTimeout(resolve, ctx.timeoutMs)))]);
    clearTimeout(timer);
    if (!result) throw new StepFailure("dialog_failed", "dialog did not appear");
    if (result.kindError) throw new StepFailure("dialog_failed", result.kindError);
    if (ctx.expected && !result.message.includes(ctx.expected)) {
      throw new StepFailure("assertion_failed", `Dialog message does not contain "${ctx.expected}"`, { expected: ctx.expected, actual: result.message });
    }
  } finally {
    ctx.session.dialogHandler = undefined;
  }
}

// ---- auto-scroll (spec 2.10) ----

const SCROLL_ACTIONS = new Set<Step["action"]>([
  "click", "fill", "select", "hover", "pressKey", "clickFirstEnabled", "clickAndWaitPopup",
  "clickAndAcceptDialog", "clickAndDismissDialog", "clickAndSubmitPrompt", "uploadFile",
  "clickInPopup", "fillInPopup", "clickInIframe", "fillInIframe",
  "assertVisible", "assertVisibleOrWarn", "assertText", "assertVisibleInIframe", "assertVisibleInPopup", "waitForSelector",
]);
/** Checks that scroll once more after passing when the scroll before them found nothing. */
const SCROLL_AGAIN = new Set<Step["action"]>(["assertVisible", "assertVisibleOrWarn", "assertText", "assertVisibleInIframe", "assertVisibleInPopup"]);
const POPUP_ACTIONS = new Set<Step["action"]>(["clickInPopup", "fillInPopup", "assertVisibleInPopup"]);
const IFRAME_ACTIONS = new Set<Step["action"]>(["clickInIframe", "fillInIframe", "assertVisibleInIframe"]);

/** When to scroll around a step: before the action, after it, or not at all (no target). */
export function scrollPlan(step: Step, selector: string | undefined): { before: boolean; after: "always" | "if-missed" | "never" } {
  if (!SCROLL_ACTIONS.has(step.action) || !selector) return { before: false, after: "never" };
  if (step.action === "waitForSelector") return { before: false, after: "always" };
  return { before: true, after: SCROLL_AGAIN.has(step.action) ? "if-missed" : "never" };
}

/**
 * Scrolls the step's first target element to the vertical centre so recordings and screenshots show it.
 * Doesn't affect the verdict: any failure just returns false. `presentOnly` doesn't wait for the element.
 */
export async function autoScroll(ctx: ActionContext, presentOnly: boolean): Promise<boolean> {
  const limit = presentOnly ? 500 : Math.min(2000, ctx.timeoutMs);
  try {
    let target: Locator;
    if (POPUP_ACTIONS.has(ctx.step.action)) {
      const popup = ctx.session.popup;
      if (!popup || popup.isClosed()) return false;
      const { locator, exact } = await resolveTargets(popup, ctx.selector!);
      target = exact && (await exact.count()) > 0 ? exact : locator;
    } else if (IFRAME_ACTIONS.has(ctx.step.action)) {
      target = iframeTarget(ctx);
    } else {
      const { locator, exact } = await resolveTargets(ctx.session.mainPage, ctx.selector!);
      target = exact && (await exact.count()) > 0 ? exact : locator;
    }
    const first = target.first();
    if (presentOnly && (await first.count()) === 0) return false;
    await first.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }), undefined, { timeout: limit });
    await new Promise((r) => setTimeout(r, 150));
    return true;
  } catch {
    return false;
  }
}

// ---- json-ld ----

function collectCandidates(value: unknown, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectCandidates(v, out);
    return;
  }
  out.push(value);
  if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>)["@graph"])) {
    for (const v of (value as Record<string, unknown[]>)["@graph"]!) collectCandidates(v, out);
  }
}

function resolvePath(values: unknown[], path: JsonLdSegment[]): unknown[] {
  let current = values;
  for (const seg of path) {
    let next: unknown[] = [];
    for (const v of current) if (v && typeof v === "object" && !Array.isArray(v) && seg.name in v) next.push((v as Record<string, unknown>)[seg.name]);
    for (const index of seg.indexes) {
      const after: unknown[] = [];
      for (const v of next) {
        if (index === "*") after.push(...(Array.isArray(v) ? v : [v]));
        else if (Array.isArray(v) && index < v.length) after.push(v[index]);
      }
      next = after;
    }
    current = next;
  }
  return current;
}

function jsonLdHolds(candidate: unknown, path: JsonLdSegment[], op: "exists" | "equals" | "contains", value?: string): boolean {
  return resolvePath([candidate], path).some((found) => {
    if (op === "exists") {
      if (found === null || found === undefined || found === "") return false;
      if (Array.isArray(found)) return found.length > 0;
      if (typeof found === "object") return Object.keys(found).length > 0;
      return true;
    }
    // Strings, numbers and booleans compare; null and objects never match (spec 3.2).
    const scalars = (Array.isArray(found) ? found : [found]).flatMap((v) =>
      typeof v === "string" ? [v] : typeof v === "number" ? [String(v)] : typeof v === "boolean" ? [String(v)] : [],
    );
    return scalars.some((s) => (op === "equals" ? s === value : s.includes(value!)));
  });
}

// ---- helpers ----

function required(value: string | undefined, message: string): string {
  if (!value) throw new StepFailure("invalid_step", message);
  return value;
}

/** The element a secret goes into, remembered for masking before anything is typed. */
async function secretTarget(ctx: ActionContext, page: Page, locator: Locator, text = ctx.value): Promise<Locator | ElementHandle> {
  if (!ctx.valueHasSecret || text === undefined) return locator;
  const handle = await locator.elementHandle({ timeout: ctx.timeoutMs });
  ctx.session.secretFields.push({ page, handle });
  return handle;
}

async function poll(ctx: ActionContext, everyMs: number, check: () => Promise<boolean>, onTimeout: () => StepFailure): Promise<void> {
  const deadline = Date.now() + ctx.timeoutMs;
  for (;;) {
    if (await check()) return;
    if (ctx.signal.aborted) throw new StepFailure("cancelled", "Stopped");
    if (Date.now() >= deadline) throw onTimeout();
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** `http…` as is; anything else is appended to the base URL literally (spec 3.1 goto). */
function resolveUrl(value: string, baseUrl: string): string {
  const raw = /^http/i.test(value) ? value : baseUrl + value;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StepFailure("invalid_step", `Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new StepFailure("invalid_step", `Only http and https URLs can be opened: ${raw}`);
  return url.href;
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
}

/** Maps a Playwright error to a step failure. */
export function classify(err: unknown): StepFailure {
  if (err instanceof StepFailure) return err;
  const message = firstLine(err);
  if (err instanceof errors.TimeoutError) return new StepFailure("timeout", message);
  if (/ERR_BLOCKED_BY_CLIENT/.test(message)) return new StepFailure("blocked_request", message);
  if (/has been closed|Target closed|Browser closed|crashed/i.test(message)) return new StepFailure("infra", message, {}, "error");
  if (/Unexpected token|not a valid selector|Unknown engine|Malformed selector/i.test(message)) return new StepFailure("invalid_step", message);
  return new StepFailure(undefined, message);
}
