// `BrowserDriver` on the stage 4 side browser (stage 6 contract section 5). Clicks, hovers and typing are real input
// events sent to the tab; page scripts only measure. Element checks run in the page, so a hostile page can lie
// about its own elements — that only affects what the AI sees of that page.
import type { WebContents } from "electron";
import { MCP_SOCKET_TIMINGS } from "@defe2end/shared";
import { maskVerdict, type BrowserDriver, type BrowserTab, type ElementInfo, type MaskReport } from "./core/mcp-browser.js";
import { McpOpError } from "./core/mcp-socket-server.js";
import type { SideBrowser } from "./side-browser.js";

const MASK_ATTR = "data-defe2end-ai-mask";
const SENSITIVE = `input[type=password], input[autocomplete^="cc-"], input[autocomplete="current-password"], input[autocomplete="new-password"], input[autocomplete="one-time-code"]`;

/**
 * In-page `cleanHtml(el)`: serializes a copy with values already gone — form values and the `value` attribute,
 * textarea content, sensitive fields' options, and every non-test `data-*` value — so nothing secret depends on
 * `redactDom` seeing a complete tag. Long output is cut before an unfinished tag, never inside one.
 */
const CLEAN_HTML_SOURCE = `const cleanHtml = (el) => {
  const KEEP = new Set(["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"]);
  const copy = el.cloneNode(true);
  const all = [copy, ...copy.querySelectorAll("*")];
  for (const n of all) {
    const tag = n.tagName.toLowerCase();
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase();
      if (name === "value" || (name.startsWith("data-") && !KEEP.has(name))) n.setAttribute(a.name, "");
    }
    if (tag === "textarea") n.textContent = "";
    if (tag === "select" && n.matches(${JSON.stringify(SENSITIVE.replace(/input/g, "select"))})) n.textContent = "";
    if (tag === "script" || tag === "style") n.textContent = "";
  }
  let html = copy.outerHTML;
  if (html.length > 200000) {
    html = html.slice(0, 200000);
    const open = html.lastIndexOf("<");
    if (open > html.lastIndexOf(">")) html = html.slice(0, open);
  }
  return html;
};`;

interface Probe {
  error?: "element-not-found" | "invalid-selector";
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  visible?: boolean;
  covered?: boolean;
  credential?: boolean;
}

const probeScript = (selector: string) => `(() => {
  let el;
  try { el = document.querySelector(${JSON.stringify(selector)}); } catch { return { error: "invalid-selector" }; }
  if (!el) return { error: "element-not-found" };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const visible = r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  const covered = !top || !(top === el || el.contains(top) || top.contains(el));
  const credential = el.matches(${JSON.stringify(SENSITIVE)});
  return { x: cx, y: cy, w: r.width, h: r.height, visible, covered, credential };
})()`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KEY_CODES: Record<string, string> = { Enter: "Enter", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Space: "Space" };

export function sideBrowserDriver(getBrowser: () => SideBrowser | null): BrowserDriver {
  const browser = () => {
    const b = getBrowser();
    if (!b) throw new McpOpError("browser-not-open", "The side browser isn't open");
    return b;
  };
  const contents = (tabId?: string): WebContents => {
    const c = browser().aiContents(tabId);
    if (!c) throw new McpOpError(tabId ? "tab-not-found" : "browser-not-open", tabId ? "No such tab" : "No open tab");
    return c;
  };
  const evaluate = async <T>(script: string, c = contents()): Promise<T> => {
    try {
      return (await c.executeJavaScript(script, true)) as T;
    } catch {
      throw new McpOpError("frame-unreachable", "The page couldn't be read");
    }
  };

  /** Waits for the element to stop moving (2 s), then checks it can take a pointer event. */
  const locate = async (selector: string, signal: AbortSignal, needPointer: boolean): Promise<Probe> => {
    const deadline = Date.now() + MCP_SOCKET_TIMINGS.elementSettleWaitMs;
    let last = await evaluate<Probe>(probeScript(selector));
    for (;;) {
      if (last.error) throw new McpOpError(last.error, last.error === "invalid-selector" ? "Invalid selector" : "Element not found");
      if (signal.aborted) throw signal.reason;
      await sleep(100);
      const now = await evaluate<Probe>(probeScript(selector));
      const settled = !now.error && now.x === last.x && now.y === last.y && now.w === last.w && now.h === last.h;
      last = now;
      if (settled || Date.now() > deadline) break;
    }
    if (last.error) throw new McpOpError(last.error, "Element not found");
    if (!last.visible) throw new McpOpError("element-not-visible", "The element isn't visible");
    if (needPointer && last.covered) throw new McpOpError("element-not-clickable", "Something covers the element");
    return last;
  };

  const pointer = (c: WebContents, p: Probe, click: boolean) => {
    const x = Math.round(p.x!);
    const y = Math.round(p.y!);
    c.sendInputEvent({ type: "mouseMove", x, y });
    if (!click) return;
    c.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    c.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  };

  const pressKey = (c: WebContents, key: string) => {
    const keyCode = KEY_CODES[key] ?? key;
    c.sendInputEvent({ type: "keyDown", keyCode });
    if (key === "Enter" || key === "Space") c.sendInputEvent({ type: "char", keyCode: key === "Enter" ? "\r" : " " });
    c.sendInputEvent({ type: "keyUp", keyCode });
  };

  return {
    isRecording: () => getBrowser()?.isRecording ?? false,
    requestOpen: () => getBrowser()?.requestOpen(),
    hasTab: () => getBrowser()?.hasTabs ?? false,
    tabs: (): BrowserTab[] => getBrowser()?.aiTabs() ?? [],
    async navigate(url, tabId) {
      const c = contents(tabId);
      if (tabId) browser().select(tabId);
      await c.loadURL(url).catch(() => {
        // Aborted loads (redirects, downloads) still leave the tab somewhere; the tab list tells where.
      });
    },
    async newTab(url) {
      const id = browser().aiNewTab(url ?? "about:blank");
      return browser().aiTabs().find((t) => t.id === id)!;
    },
    activate: (tabId) => browser().select(tabId),
    async click(selector, signal) {
      const c = contents();
      pointer(c, await locate(selector, signal, true), true);
    },
    async hover(selector, signal) {
      const c = contents();
      pointer(c, await locate(selector, signal, true), false);
    },
    async isCredentialField(selector) {
      const p = await evaluate<Probe>(probeScript(selector));
      if (p.error) throw new McpOpError(p.error, p.error === "invalid-selector" ? "Invalid selector" : "Element not found");
      return p.credential === true;
    },
    async fill(selector, value, signal) {
      const c = contents();
      const p = await locate(selector, signal, true);
      if (p.credential) throw new McpOpError("credential-field", "AI can't type into password fields");
      pointer(c, p, true);
      await evaluate(`(() => { const el = document.activeElement; if (el && "select" in el) el.select(); })()`, c);
      c.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
      c.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
      if (value) await c.insertText(value);
    },
    async press(key) {
      pressKey(contents(), key);
    },
    async scroll(args) {
      const target = args.selector ? `document.querySelector(${JSON.stringify(args.selector)})` : "null";
      const res = await evaluate<string | null>(`(() => {
        let el; try { el = ${target}; } catch { return "invalid-selector"; }
        if (${JSON.stringify(!!args.selector)} && !el) return "element-not-found";
        if (el && ${JSON.stringify(args.by === undefined && args.to === undefined)}) { el.scrollIntoView({ block: "center" }); return null; }
        const box = el ?? document.scrollingElement ?? document.documentElement;
        ${args.to === "top" ? "box.scrollTop = 0;" : args.to === "bottom" ? "box.scrollTop = box.scrollHeight;" : ""}
        ${args.by !== undefined ? `box.scrollTop += ${Number(args.by)};` : ""}
        return null;
      })()`);
      if (res) throw new McpOpError(res as "invalid-selector", res === "invalid-selector" ? "Invalid selector" : "Element not found");
    },
    async query(selector, limit) {
      const res = await evaluate<ElementInfo[] | "invalid-selector">(`(() => {
        let list; try { list = [...document.querySelectorAll(${JSON.stringify(selector)})]; } catch { return "invalid-selector"; }
        ${CLEAN_HTML_SOURCE}
        return list.slice(0, ${limit}).map((el) => {
          const r = el.getBoundingClientRect();
          return { tag: el.tagName.toLowerCase(), outerHtml: cleanHtml(el), visible: r.width > 0 && r.height > 0 };
        });
      })()`);
      if (res === "invalid-selector") throw new McpOpError("invalid-selector", "Invalid selector");
      return res;
    },
    pageText: () => evaluate<string>(`(document.body?.innerText ?? "").slice(0, 100000)`),
    async maskSensitive() {
      // Sensitive inputs are searched in the page, open shadow roots and same-origin frames; each gets an opaque
      // box in the top document. The box must be what the top document hits at five points of the input's visible
      // rectangle (centre and four inset corners), so a modal above it or a wrong position fails. Frame offsets are
      // only trusted without transforms/zoom on the frame chain; anything we can't place for sure fails the check,
      // as does a frame we can't look into.
      const report = await evaluate<MaskReport>(`(() => {
        const SEL = ${JSON.stringify(SENSITIVE)};
        const found = [];
        let unreachableFrames = 0, uncertain = 0;
        const plain = (n) => { const cs = getComputedStyle(n); return cs.transform === "none" && (cs.zoom === "" || cs.zoom === "1" || cs.zoom === "normal") && cs.perspective === "none"; };
        /** The frame element and all of its ancestors, across shadow roots and parent frames. */
        const chainIsPlain = (n) => {
          for (let x = n; x; ) {
            if (x.nodeType === 1 && !plain(x)) return false;
            const root = x.getRootNode();
            x = x.parentElement ?? (root && root.host) ?? (x.ownerDocument && x.ownerDocument.defaultView && x.ownerDocument.defaultView.frameElement) ?? null;
          }
          return true;
        };
        const walk = (root, dx, dy, certain) => {
          for (const el of root.querySelectorAll(SEL)) found.push({ el, dx, dy, certain });
          for (const host of root.querySelectorAll("*")) if (host.shadowRoot) walk(host.shadowRoot, dx, dy, certain);
          for (const frame of root.querySelectorAll("iframe, frame")) {
            let doc = null;
            try { doc = frame.contentDocument; } catch {}
            const fr = frame.getBoundingClientRect();
            if (!doc || !doc.documentElement) { if (fr.width > 0 && fr.height > 0) unreachableFrames++; continue; }
            const cs = getComputedStyle(frame);
            const ox = fr.left + frame.clientLeft + parseFloat(cs.paddingLeft || "0");
            const oy = fr.top + frame.clientTop + parseFloat(cs.paddingTop || "0");
            walk(doc, dx + ox, dy + oy, certain && chainIsPlain(frame) && plain(doc.documentElement) && (!doc.body || plain(doc.body)));
          }
        };
        walk(document, 0, 0, plain(document.documentElement) && (!document.body || plain(document.body)));
        const vw = innerWidth, vh = innerHeight;
        let covered = 0;
        for (const { el, dx, dy, certain } of found) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) { covered++; continue; }
          if (!certain) { uncertain++; continue; }
          const left = r.left + dx, top = r.top + dy, right = left + r.width, bottom = top + r.height;
          const vl = Math.max(left, 0), vt = Math.max(top, 0), vr = Math.min(right, vw), vb = Math.min(bottom, vh);
          if (vr <= vl || vb <= vt) { covered++; continue; }
          const box = document.createElement("div");
          box.setAttribute("${MASK_ATTR}", "");
          box.style.cssText = "position:fixed;z-index:2147483647;background:#222;pointer-events:auto;margin:0;padding:0;border:0;transform:none;left:" + (left - 2) + "px;top:" + (top - 2) + "px;width:" + (r.width + 4) + "px;height:" + (r.height + 4) + "px";
          document.documentElement.appendChild(box);
          const ix = Math.min(1, (vr - vl) / 4), iy = Math.min(1, (vb - vt) / 4);
          const points = [[(vl + vr) / 2, (vt + vb) / 2], [vl + ix, vt + iy], [vr - ix, vt + iy], [vl + ix, vb - iy], [vr - ix, vb - iy]];
          if (points.every(([x, y]) => document.elementFromPoint(x, y) === box)) covered++;
        }
        return { inputs: found.length, covered, unreachableFrames, uncertain };
      })()`);
      await sleep(50);
      return maskVerdict(report);
    },
    async unmaskSensitive() {
      await evaluate(`document.querySelectorAll("[${MASK_ATTR}]").forEach((n) => n.remove())`);
    },
    async screenshot(maxEdge) {
      const image = await contents().capturePage();
      const { width, height } = image.getSize();
      const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
      const out = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : image;
      return out.toPNG();
    },
    setAiActive: (active) => getBrowser()?.setAiActive(active),
  };
}
