// In-page event collection (desktop spec 5.3–5.4): DOM events → raw events. Like `recorderDom`, `installCollector`
// is one self-contained function so the tab preload and Playwright tests run the same code. The preload owns IPC:
// it passes `send` (→ `recorder:event`) and toggles recording on `recorder:state`.
/// <reference lib="dom" />
import type { RecorderDom } from "./dom.js";
import type { RawEvent } from "./index.js";

/** Raw event without the fields only the main process knows for sure (it may overwrite `at` and `pageUrl`). */
export type CollectedEvent = RawEvent;

export interface CollectorOptions {
  dom: RecorderDom;
  send(event: RawEvent): void;
  testAttributes: readonly string[];
  /** Labels for the in-page check menu, in this order: visible, visible (warn only), text, hover. */
  menuLabels?: readonly [string, string, string, string];
}

/** Payload of `recorder:state` (main → every frame of the tab). */
export interface RecorderState {
  recording: boolean;
  tabId: string;
  testAttributes?: readonly string[];
  menuLabels?: readonly [string, string, string, string];
}

export interface Collector {
  /** Starts or stops recording for this tab; events carry `tabId`. Given lists replace the current ones, even mid-recording. */
  setState(state: RecorderState): void;
  /** Feeds a dialog result reported by the main-world wrapper (`DIALOG_WRAPPER_SOURCE`); `openMs` = how long it was open. */
  dialog(kind: "alert" | "confirm" | "prompt", accepted: boolean, openMs?: number): void;
}

/**
 * Main-world script that wraps alert/confirm/prompt and posts `{ __defe2endDialog: { kind, accepted, openMs } }` when
 * the dialog closes. A `prompt()` that throws (Electron doesn't support it) is still reported, as dismissed.
 */
export const DIALOG_WRAPPER_SOURCE = `(() => {
  if (window.__defe2endDialogs) return;
  window.__defe2endDialogs = true;
  for (const kind of ["alert", "confirm", "prompt"]) {
    const original = window[kind].bind(window);
    window[kind] = (...args) => {
      const opened = Date.now();
      const report = (accepted) => window.postMessage({ __defe2endDialog: { kind, accepted, openMs: Math.max(0, Date.now() - opened) } }, "*");
      let result;
      try {
        result = original(...args);
      } catch (error) {
        report(false);
        throw error;
      }
      report(kind === "alert" ? true : kind === "confirm" ? result === true : result !== null);
      return result;
    };
  }
})();`;

export function installCollector(options: CollectorOptions): Collector {
  const SCROLL_QUIET_MS = 600;
  const EDGE_PX = 40;
  const HIGHLIGHT_MS = 600;
  const CLICK_INPUT_TYPES = ["button", "submit", "checkbox", "radio", "image", "file"];
  const NO_FILL_TYPES = ["checkbox", "radio", "button", "submit", "file", "image", "reset"];
  const CHECKS = ["assertVisible", "assertVisibleOrWarn", "assertText", "hover"] as const;
  let labels: readonly string[] = options.menuLabels ?? ["Check visible", "Check visible (warn only)", "Check text", "Hover"];
  let testAttributes: readonly string[] = [...options.testAttributes];
  const { dom, send } = options;
  const isTop = window === window.top;
  const frameKey = Math.random().toString(36).slice(2, 8);
  let state = { recording: false, tabId: "" };
  let seq = 0;
  let lastFill: { el: Element; value: string } | undefined;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  let menu: HTMLElement | undefined;

  const pageUrl = () => {
    try {
      return window.top!.location.href;
    } catch {
      return isTop ? location.href : "";
    }
  };
  const base = () => ({ id: `${state.tabId}-${frameKey}-${++seq}`, tabId: state.tabId, at: Date.now(), pageUrl: pageUrl(), frame: { isSubframe: !isTop, url: location.href } });
  const emit = (event: Record<string, unknown>) => {
    if (state.recording) send({ ...base(), ...event } as RawEvent);
  };
  const describe = (el: Element) => dom.describe(el, testAttributes);
  const typeOf = (el: Element) => (el.getAttribute("type") ?? "text").toLowerCase();
  const isFillable = (el: Element) => el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !NO_FILL_TYPES.includes(typeOf(el)));

  function emitFill(el: HTMLInputElement | HTMLTextAreaElement) {
    const isPassword = el.tagName === "INPUT" && typeOf(el) === "password";
    const value = isPassword ? "{{PASSWORD}}" : el.value;
    if (lastFill && lastFill.el === el && lastFill.value === el.value) return;
    lastFill = { el, value: el.value };
    emit({ type: "input", target: describe(el), value, isPassword });
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!state.recording || !(e.target instanceof Element) || menu?.contains(e.target)) return;
      const el = dom.actionable(e.target);
      if (el.tagName === "SELECT" || el.tagName === "TEXTAREA") return;
      if (el.tagName === "INPUT" && !CLICK_INPUT_TYPES.includes(typeOf(el))) return;
      emit({ type: "click", target: describe(el) });
    },
    true,
  );

  document.addEventListener(
    "change",
    (e) => {
      const el = e.target;
      if (el instanceof HTMLSelectElement) {
        const option = el.selectedOptions[0];
        emit({ type: "select", target: describe(el), label: option ? option.label : "" });
      } else if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && isFillable(el)) {
        emitFill(el);
      }
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || !state.recording) return;
      const el = e.target;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || !isFillable(el)) return;
      const composing = e.isComposing || e.keyCode === 229;
      if (!composing) emitFill(el);
      emit({ type: "key", key: "Enter", target: describe(el), composing });
    },
    true,
  );

  if (isTop) {
    window.addEventListener(
      "scroll",
      () => {
        if (!state.recording) return;
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          const y = Math.round(window.scrollY);
          const max = document.documentElement.scrollHeight - window.innerHeight;
          emit({ type: "scroll", y, atTop: y <= EDGE_PX, atBottom: y >= max - EDGE_PX });
        }, SCROLL_QUIET_MS);
      },
      { passive: true },
    );
  }

  function closeMenu() {
    menu?.remove();
    menu = undefined;
  }

  document.addEventListener(
    "contextmenu",
    (e) => {
      if (!state.recording || !(e.target instanceof Element)) return;
      e.preventDefault();
      closeMenu();
      const el = e.target;
      const html = el as HTMLElement;
      const outline = html.style.outline;
      html.style.outline = "2px solid #e5484d";
      setTimeout(() => (html.style.outline = outline), HIGHLIGHT_MS);
      const host = document.createElement("div");
      host.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:2147483647;background:#fff;border:1px solid #ccc;font:13px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.2)`;
      host.setAttribute("data-defe2end-menu", "");
      CHECKS.forEach((check, i) => {
        const item = document.createElement("div");
        item.textContent = labels[i]!;
        item.style.cssText = "padding:6px 12px;cursor:pointer";
        item.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          closeMenu();
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
          emit({ type: "contextmenu", check, target: describe(el), ...(text && { text }) });
        });
        host.appendChild(item);
      });
      document.documentElement.appendChild(host);
      menu = host;
    },
    true,
  );
  document.addEventListener("mousedown", (e) => {
    if (menu && !(e.target instanceof Node && menu.contains(e.target))) closeMenu();
  }, true);

  return {
    setState(next) {
      state = { recording: next.recording, tabId: next.tabId };
      if (next.testAttributes) testAttributes = [...next.testAttributes];
      if (next.menuLabels) labels = [...next.menuLabels];
      if (!next.recording) {
        closeMenu();
        lastFill = undefined;
      }
    },
    dialog(kind, accepted, openMs) {
      emit({ type: "dialog", kind, accepted, ...(typeof openMs === "number" && openMs >= 0 && { openMs: Math.round(openMs) }) });
    },
  };
}
