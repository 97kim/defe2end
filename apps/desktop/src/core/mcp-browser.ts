// Stage 6 contract section 5: browser ops on the stage 4 side browser. The rules live here (open-and-wait,
// http/https only, recording refusal, password fields, press keys, limits, redaction before replying); the
// Electron side only implements `BrowserDriver`. Page content never goes to the server.
import { BROWSER_LIMITS, BROWSER_PRESS_KEYS, isAllowedBrowserUrl, MCP_SOCKET_TIMINGS, redactDom, redactText, redactUrl, type McpToolName } from "@defe2end/shared";
import { McpOpError, type McpCallContext } from "./mcp-socket-server.js";

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface ElementInfo {
  tag: string;
  /** Not sent: the reply's text is built from the redacted `outerHtml`. */
  text?: string;
  outerHtml: string;
  visible: boolean;
}

/** What the side browser must provide. Element methods throw `McpOpError` with the browser codes. */
export interface BrowserDriver {
  isRecording(): boolean;
  /** Asks the web UI to show the side browser (it owns the bounds). */
  requestOpen(): void;
  hasTab(): boolean;
  tabs(): BrowserTab[];
  navigate(url: string, tabId?: string): Promise<void>;
  newTab(url?: string): Promise<BrowserTab>;
  activate(tabId: string): void;
  /** Real input events at the element's center; refuses covered elements. */
  click(selector: string, signal: AbortSignal): Promise<void>;
  hover(selector: string, signal: AbortSignal): Promise<void>;
  /** True when the element is a password field (checked before typing). */
  isCredentialField(selector: string): Promise<boolean>;
  fill(selector: string, value: string, signal: AbortSignal): Promise<void>;
  press(key: string): Promise<void>;
  scroll(args: { to?: "top" | "bottom"; by?: number; selector?: string }): Promise<void>;
  query(selector: string, limit: number): Promise<ElementInfo[]>;
  pageText(): Promise<string>;
  /** Covers password/card inputs; resolves true only when the overlay is confirmed. */
  maskSensitive(): Promise<boolean>;
  unmaskSensitive(): Promise<void>;
  /** PNG, long edge at most `maxEdge`. */
  screenshot(maxEdge: number): Promise<Buffer>;
  /** The "AI is operating" sign. */
  setAiActive(active: boolean): void;
}

/** What the screenshot overlay found (page, open shadow roots, same-origin frames). */
export interface MaskReport {
  inputs: number;
  /** Inputs whose box is what the top document hits (or that are off screen). */
  covered: number;
  /** Visible frames whose document couldn't be read (other origin): their fields can't be checked. */
  unreachableFrames: number;
  /** Inputs that couldn't be placed for sure (a transform or zoom on their frame chain): not covered, refused. */
  uncertain?: number;
}

/** Only a full, checkable cover allows the screenshot. */
export function maskVerdict(report: MaskReport | null | undefined): boolean {
  if (!report) return false;
  return report.unreachableFrames === 0 && !report.uncertain && report.covered === report.inputs;
}

export interface BrowserOpsOptions {
  driver: BrowserDriver;
  sleep?(ms: number): Promise<void>;
  /** Tests: how long the AI sign stays on after the last acting op ends. */
  aiSignHoldMs?: number;
}

/** A navigate or click ends in well under a second; the sign stays on this long after it so a person can see it. */
export const AI_SIGN_HOLD_MS = 2000;

const READ_ONLY = new Set<McpToolName>(["browser_query_dom", "browser_page_text", "browser_screenshot", "browser_tabs"]);

export function isBrowserOp(op: string): boolean {
  return op.startsWith("browser_");
}

export class BrowserOps {
  private active = 0;
  private signOff: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly opts: BrowserOpsOptions) {}

  private signStart(): void {
    if (this.signOff) clearTimeout(this.signOff);
    else if (this.active === 0) this.opts.driver.setAiActive(true);
    this.signOff = null;
    this.active++;
  }

  private signEnd(): void {
    if (--this.active > 0) return;
    this.signOff = setTimeout(() => {
      this.signOff = null;
      this.opts.driver.setAiActive(false);
    }, this.opts.aiSignHoldMs ?? AI_SIGN_HOLD_MS);
  }

  async call(op: McpToolName, args: Record<string, unknown>, ctx: McpCallContext): Promise<unknown> {
    const { driver } = this.opts;
    if (driver.isRecording()) throw new McpOpError("recording-in-progress", "Recording is in progress; AI can't use the browser now");
    if ((op === "browser_navigate" || op === "browser_tab_new") && typeof args.url === "string" && !isAllowedBrowserUrl(args.url)) {
      throw new McpOpError("scheme-not-allowed", "Only http and https addresses can be opened");
    }
    if (op === "browser_press" && !(BROWSER_PRESS_KEYS as readonly string[]).includes(args.key as string)) throw new McpOpError("invalid-args", "Key not allowed");
    await this.ensureOpen(ctx.signal);
    const acting = !READ_ONLY.has(op);
    if (acting) this.signStart();
    try {
      return await this.run(op, args, ctx);
    } finally {
      if (acting) this.signEnd();
    }
  }

  private async ensureOpen(signal: AbortSignal): Promise<void> {
    const { driver } = this.opts;
    if (driver.hasTab()) return;
    driver.requestOpen();
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + MCP_SOCKET_TIMINGS.browserOpenWaitMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw signal.reason;
      await sleep(MCP_SOCKET_TIMINGS.browserOpenPollMs);
      if (driver.hasTab()) return;
    }
    throw new McpOpError("browser-not-open", "The side browser didn't open");
  }

  private async run(op: McpToolName, args: Record<string, unknown>, ctx: McpCallContext): Promise<unknown> {
    const { driver } = this.opts;
    const selector = args.selector as string;
    switch (op) {
      case "browser_navigate":
        await driver.navigate(args.url as string, args.tabId as string | undefined);
        return { tabs: this.tabs() };
      case "browser_tab_new":
        return { tab: redactTab(await driver.newTab(args.url as string | undefined)) };
      case "browser_tab_activate":
        if (!driver.tabs().some((t) => t.id === args.tabId)) throw new McpOpError("tab-not-found", "No such tab");
        driver.activate(args.tabId as string);
        return { tabs: this.tabs() };
      case "browser_tabs":
        return { tabs: this.tabs() };
      case "browser_click":
        await driver.click(selector, ctx.signal);
        return { ok: true };
      case "browser_hover":
        await driver.hover(selector, ctx.signal);
        return { ok: true };
      case "browser_fill":
        if (await driver.isCredentialField(selector)) throw new McpOpError("credential-field", "AI can't type into password fields");
        await driver.fill(selector, args.value as string, ctx.signal);
        return { ok: true };
      case "browser_press":
        await driver.press(args.key as string);
        return { ok: true };
      case "browser_scroll":
        await driver.scroll(args as { to?: "top" | "bottom"; by?: number; selector?: string });
        return { ok: true };
      case "browser_query_dom": {
        const limit = Math.min((args.limit as number | undefined) ?? BROWSER_LIMITS.maxElements, BROWSER_LIMITS.maxElements);
        const found = await driver.query(selector, limit);
        return {
          elements: found.slice(0, limit).map((e) => {
            // Text comes from the redacted markup, not the page's innerText: sensitive fields' content
            // (textarea, password/card selects, input values) is gone before anything is read out.
            const html = redactDom(e.outerHtml);
            return {
              tag: e.tag,
              visible: e.visible,
              text: textOfHtml(html).slice(0, BROWSER_LIMITS.outerHtmlChars),
              ...(args.includeHtml ? { html: cutHtml(html, BROWSER_LIMITS.outerHtmlChars) } : {}),
            };
          }),
        };
      }
      case "browser_page_text":
        return { text: redactText(await driver.pageText()).slice(0, BROWSER_LIMITS.pageTextChars) };
      case "browser_screenshot": {
        if (!(await driver.maskSensitive().catch(() => false))) {
          await driver.unmaskSensitive().catch(() => {});
          throw new McpOpError("masking-failed", "Couldn't cover sensitive fields; no screenshot taken");
        }
        try {
          const png = await driver.screenshot(BROWSER_LIMITS.screenshotLongEdgePx);
          return { image: png.toString("base64"), mimeType: "image/png" };
        } finally {
          await driver.unmaskSensitive().catch(() => {});
        }
      }
      default:
        throw new McpOpError("unknown-op", `Unknown op: ${op}`);
    }
  }

  private tabs() {
    return this.opts.driver.tabs().map(redactTab);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** At most `max` characters, never ending inside a tag (an unfinished tag is dropped). */
export function cutHtml(html: string, max: number): string {
  if (html.length <= max) return html;
  const cut = html.slice(0, max);
  const open = cut.lastIndexOf("<");
  return open > cut.lastIndexOf(">") ? cut.slice(0, open) : cut;
}

/** Visible text of (already redacted) markup. */
export function textOfHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function redactTab(tab: BrowserTab): BrowserTab {
  return { ...tab, url: redactUrl(tab.url), title: redactText(tab.title) };
}
