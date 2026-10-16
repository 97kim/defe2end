// Scenario-mode conversion (desktop spec 5.3–5.6): raw events → steps, one `sourceEventIds` entry per step.
import { DEFAULT_LOCALE, messages, type Locale } from "@defe2end/i18n";
import { stepSchema, type Step } from "@defe2end/shared";
import type { ConvertOptions, ElementInfo, RawEvent, RecordingResult, RecordingWarning } from "./index.js";

export const CLICK_MERGE_MS = 800;
export const DIALOG_WINDOW_MS = 2000;
export const POPUP_WINDOW_MS = 2000;
export const HOVER_WINDOW_MS = 10_000;
export const CONDITIONAL_TIMEOUT_MS = 5000;
export const NAVIGATION_TIMEOUT_MS = 30_000;
export const PASSWORD_VALUE = "{{PASSWORD}}";
const IFRAME_PATH_MAX = 60;
const NAME_TEXT_MAX = 20;

/** Warning codes the web UI's message catalog knows. */
export const WARNING_CODES = [
  "otherTab", // events from tabs outside the start tab's lineage (count)
  "popupNested", // a window opened by a popup; its events are dropped
  "popupNoTrigger", // no click right before the popup opened; the popup's events are dropped
  "popupUnsupported", // key/scroll/select/hover/text check/dialog/iframe inside a popup (count, one per kind)
  "popupOpenerEvent", // start-tab events while a popup is open (count)
  "popupNotClosed", // closePopup added at the end
  "dialogUnmatched", // no click within 2000 ms before the dialog
  "dialogPrompt", // prompt dialogs can't be recorded; add clickAndSubmitPrompt by hand
  "iframeRootPath", // the frame's path is `/`, so no iframe selector
  "iframeUnsupported", // select/key/check inside an iframe
  "noSelector", // the target had no selector candidate
  "invalidStep", // a step the shared step schema rejects
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

type Meta = { kind: "click" | "fill" | "url" | "scroll" | "other"; at: number; scrollBottom?: boolean; scrollBase?: number; iframe?: string };

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function startPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

type StepText = (typeof messages)["en"]["recorder"]["steps"];
type TargetKey = "element" | "field" | "option" | "password";
type VerbKey = "click" | "fill" | "select" | "hover" | "waitFor" | "checkVisible" | "checkVisibleOrWarn" | "checkText";

/** Step names from the `recorder.steps` messages (desktop spec 5.6). */
function stepNames(locale: Locale) {
  const text: StepText = messages[locale].recorder.steps;
  const t = (key: keyof StepText, vars: Record<string, string> = {}) => text[key].replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
  return {
    t,
    named(verb: VerbKey, label: string | undefined, fallback: TargetKey): string {
      const l = label?.replace(/\s+/g, " ").trim();
      return t(verb, { target: l ? t("quoted", { text: l.slice(0, NAME_TEXT_MAX) }) : t(fallback) });
    },
  };
}

function iframeSelector(frameUrl: string): string | undefined {
  const path = pathOf(frameUrl);
  if (path === "/" || path === "") return undefined;
  return `iframe[src*="${path.slice(0, IFRAME_PATH_MAX).replace(/"/g, "")}"]`;
}

export function convertEvents(events: readonly RawEvent[], options: ConvertOptions): RecordingResult {
  let origin = "";
  try {
    origin = new URL(options.startUrl).origin;
  } catch {
    // An invalid start URL leaves the origin empty.
  }
  const names = stepNames(options.locale ?? DEFAULT_LOCALE);
  const steps: Step[] = [];
  const sources: string[][] = [];
  const meta: Meta[] = [];
  const warnings: RecordingWarning[] = [];
  const counted = new Map<string, RecordingWarning>();
  let nextId = 1;

  const warn = (code: WarningCode, eventIds: string[]) => warnings.push({ code, eventIds });
  const count = (code: string, eventId: string) => {
    const w = counted.get(code);
    if (w) {
      w.eventIds.push(eventId);
      w.count = (w.count ?? 0) + 1;
    } else {
      const created = { code, eventIds: [eventId], count: 1 };
      counted.set(code, created);
      warnings.push(created);
    }
  };
  const push = (step: Omit<Step, "id">, ids: string[], m: Meta): boolean => {
    const parsed = stepSchema.safeParse({ id: `s${nextId}`, ...step });
    if (!parsed.success) {
      warn("invalidStep", ids);
      return false;
    }
    nextId++;
    steps.push(parsed.data);
    sources.push([...ids]);
    meta.push(m);
    return true;
  };
  /** Replaces the last step in place; drops the change if the schema rejects it. */
  const replaceLast = (step: Step, ids: string[], m?: Partial<Meta>): boolean => {
    const parsed = stepSchema.safeParse(step);
    if (!parsed.success) {
      warn("invalidStep", ids);
      return false;
    }
    const i = steps.length - 1;
    steps[i] = parsed.data;
    for (const id of ids) if (!sources[i]!.includes(id)) sources[i]!.push(id);
    if (m) meta[i] = { ...meta[i]!, ...m };
    return true;
  };
  const last = () => (steps.length ? { step: steps[steps.length - 1]!, meta: meta[meta.length - 1]!, i: steps.length - 1 } : undefined);

  push({ action: "goto", name: names.t("startPage"), url: startPath(options.startUrl) }, [], { kind: "other", at: 0 });

  // Lineage: the start tab plus windows it opened directly.
  const startTab = options.startTabId;
  const popupTabs = new Set<string>();
  const droppedTabs = new Set<string>();
  let popup: { tabId: string; openId: string; urlChecked: boolean } | undefined;

  let currentPath = pathOf(options.startUrl);
  let urlFromPath = currentPath; // where the last waitForUrl/assertUrl pair navigated from
  let waitBeforeNext: string[] | undefined; // navigation event ids that ask for a waitForSelector before the next action
  let mergeFrom = 0; // steps before this index were made before the last navigation and never merge with new events

  let hover: { at: number } | undefined;
  let scrollY = 0;

  const selectorOf = (target: ElementInfo, eventId: string): string | undefined => {
    const s = target.selectors[0];
    if (!s) warn("noSelector", [eventId]);
    return s;
  };
  const beforeAction = (selector: string, text: string | undefined, eventId: string, at: number) => {
    if (waitBeforeNext) {
      push({ action: "waitForSelector", name: names.named("waitFor", text, "element"), selector, timeout: NAVIGATION_TIMEOUT_MS }, [...waitBeforeNext, eventId], { kind: "other", at });
      waitBeforeNext = undefined;
    }
  };

  for (const e of events) {
    // Lineage and popup bookkeeping first.
    if (e.type === "popupOpen") {
      if (e.openerTabId === startTab) {
        const prev = last();
        if (prev && prev.meta.kind === "click" && prev.step.action === "click" && e.at - prev.meta.at <= POPUP_WINDOW_MS) {
          replaceLast({ ...prev.step, action: "clickAndWaitPopup", name: names.t("newWindow", { name: prev.step.name ?? names.named("click", undefined, "element") }) }, [e.id], { kind: "other" });
          popupTabs.add(e.tabId);
          // The URL is checked where the popup first lands (its first navigate), not where it was asked to open.
          popup = { tabId: e.tabId, openId: e.id, urlChecked: false };
        } else {
          droppedTabs.add(e.tabId);
          warn("popupNoTrigger", [e.id]);
        }
      } else if (popupTabs.has(e.openerTabId) || droppedTabs.has(e.openerTabId)) {
        droppedTabs.add(e.tabId);
        warn("popupNested", [e.id]);
      } else {
        count("otherTab", e.id);
      }
      continue;
    }
    if (droppedTabs.has(e.tabId)) continue;

    if (popup && e.tabId === popup.tabId) {
      switch (e.type) {
        case "popupClose":
          push({ action: "closePopup", name: names.t("closePopup") }, [e.id], { kind: "other", at: e.at });
          popup = undefined;
          break;
        case "navigate":
          mergeFrom = steps.length;
          if (!popup.urlChecked) {
            push({ action: "assertPopupUrl", name: names.t("checkPopupUrl"), expected: `*${pathOf(e.url)}*` }, [e.id], { kind: "other", at: e.at });
            popup.urlChecked = true;
          }
          break;
        case "click": {
          if (e.frame.isSubframe) {
            count("popupUnsupported", e.id);
            break;
          }
          const selector = selectorOf(e.target, e.id);
          if (selector) push({ action: "clickInPopup", name: names.named("click", e.target.text, "element"), selector }, [e.id], { kind: "other", at: e.at });
          break;
        }
        case "input": {
          if (e.frame.isSubframe) {
            count("popupUnsupported", e.id);
            break;
          }
          const selector = selectorOf(e.target, e.id);
          if (!selector) break;
          const value = e.isPassword ? PASSWORD_VALUE : e.value;
          const prev = last();
          if (prev && prev.i >= mergeFrom && prev.step.action === "fillInPopup" && prev.step.selector === selector) replaceLast({ ...prev.step, value }, [e.id]);
          else push({ action: "fillInPopup", name: inputName(names, e.target, e.isPassword), selector, value }, [e.id], { kind: "fill", at: e.at });
          break;
        }
        case "contextmenu": {
          if (e.check !== "assertVisible" || e.frame.isSubframe) {
            count("popupUnsupported", e.id);
            break;
          }
          const selector = selectorOf(e.target, e.id);
          if (selector) push({ action: "assertVisibleInPopup", name: names.named("checkVisible", e.target.text, "element"), selector }, [e.id], { kind: "other", at: e.at });
          break;
        }
        default:
          count("popupUnsupported", e.id);
      }
      continue;
    }

    if (e.tabId !== startTab) {
      if (!popupTabs.has(e.tabId)) count("otherTab", e.id);
      continue;
    }
    if (popup) {
      count("popupOpenerEvent", e.id);
      continue;
    }

    const frameSelector = e.type !== "navigate" && e.type !== "popupClose" && e.frame.isSubframe ? iframeSelector(e.frame.url) : undefined;
    if (e.type !== "navigate" && e.type !== "popupClose" && e.type !== "dialog" && e.type !== "scroll" && e.frame.isSubframe) {
      if (e.type !== "click" && e.type !== "input") {
        warn("iframeUnsupported", [e.id]);
        continue;
      }
      if (!frameSelector) {
        warn("iframeRootPath", [e.id]);
        continue;
      }
    }

    switch (e.type) {
      case "click": {
        const selector = selectorOf(e.target, e.id);
        if (!selector) break;
        const prev = last();
        if (prev && prev.i >= mergeFrom && prev.meta.kind === "click" && e.at - prev.meta.at < CLICK_MERGE_MS) {
          const same = frameSelector ? prev.step.action === "clickInIframe" && prev.step.selector === frameSelector && prev.step.value === selector : prev.step.action === "click" && prev.step.selector === selector;
          if (same) {
            sources[prev.i]!.push(e.id);
            prev.meta.at = e.at;
            break;
          }
        }
        if (frameSelector) {
          beforeAction(frameSelector, e.target.text, e.id, e.at);
          push({ action: "clickInIframe", name: names.named("click", e.target.text, "element"), selector: frameSelector, value: selector }, [e.id], { kind: "click", at: e.at, iframe: frameSelector });
          break;
        }
        beforeAction(selector, e.target.text, e.id, e.at);
        if (hover && e.at - hover.at <= HOVER_WINDOW_MS) {
          push({ action: "waitForSelector", name: names.named("waitFor", e.target.text, "element"), selector, timeout: HOVER_WINDOW_MS }, [e.id], { kind: "other", at: e.at });
        }
        hover = undefined;
        const step: Omit<Step, "id"> = { action: "click", name: names.named("click", e.target.text, "element"), selector };
        if (e.target.inOverlay) Object.assign(step, { name: names.t("conditional", { name: step.name ?? "" }), optional: true, timeout: CONDITIONAL_TIMEOUT_MS });
        push(step, [e.id], { kind: "click", at: e.at });
        break;
      }
      case "input": {
        const selector = selectorOf(e.target, e.id);
        if (!selector) break;
        const value = e.isPassword ? PASSWORD_VALUE : e.value;
        const prev = last();
        if (frameSelector) {
          if (prev && prev.i >= mergeFrom && prev.step.action === "fillInIframe" && prev.step.selector === frameSelector && prev.step.value === selector) replaceLast({ ...prev.step, expected: value }, [e.id]);
          else {
            beforeAction(frameSelector, e.target.placeholder ?? e.target.text, e.id, e.at);
            push({ action: "fillInIframe", name: inputName(names, e.target, e.isPassword), selector: frameSelector, value: selector, expected: value }, [e.id], { kind: "fill", at: e.at });
          }
          break;
        }
        if (prev && prev.i >= mergeFrom && prev.step.action === "fill" && prev.step.selector === selector) replaceLast({ ...prev.step, value }, [e.id]);
        else {
          beforeAction(selector, e.target.placeholder ?? e.target.text, e.id, e.at);
          push({ action: "fill", name: inputName(names, e.target, e.isPassword), selector, value }, [e.id], { kind: "fill", at: e.at });
        }
        break;
      }
      case "select": {
        const selector = selectorOf(e.target, e.id);
        if (!selector) break;
        beforeAction(selector, e.target.text, e.id, e.at);
        push({ action: "select", name: names.named("select", e.target.text, "option"), selector, value: e.label }, [e.id], { kind: "other", at: e.at });
        break;
      }
      case "key": {
        if (e.composing) break;
        const selector = selectorOf(e.target, e.id);
        if (!selector) break;
        beforeAction(selector, e.target.text, e.id, e.at);
        push({ action: "pressKey", name: names.t("pressEnter"), selector, value: "Enter" }, [e.id], { kind: "other", at: e.at });
        break;
      }
      case "contextmenu": {
        const selector = selectorOf(e.target, e.id);
        if (!selector) break;
        beforeAction(selector, e.target.text, e.id, e.at);
        if (e.check === "hover") {
          if (push({ action: "hover", name: names.named("hover", e.target.text, "element"), selector }, [e.id], { kind: "other", at: e.at })) hover = { at: e.at };
        } else if (e.check === "assertText") {
          push({ action: "assertText", name: names.named("checkText", e.target.text, "element"), selector, expected: e.text?.slice(0, 80) ?? "" }, [e.id], { kind: "other", at: e.at });
        } else {
          const verb = e.check === "assertVisible" ? "checkVisible" : "checkVisibleOrWarn";
          push({ action: e.check, name: names.named(verb, e.target.text, "element"), selector }, [e.id], { kind: "other", at: e.at });
        }
        break;
      }
      case "dialog": {
        if (e.kind === "prompt") {
          warn("dialogPrompt", [e.id]);
          break;
        }
        const prev = last();
        if (!prev || prev.meta.kind !== "click" || prev.step.action !== "click" || e.at - prev.meta.at > DIALOG_WINDOW_MS) {
          warn("dialogUnmatched", [e.id]);
          break;
        }
        const accept = e.kind === "alert" || e.accepted;
        replaceLast(
          { ...prev.step, action: accept ? "clickAndAcceptDialog" : "clickAndDismissDialog", name: names.t(accept ? "accept" : "dismiss", { name: prev.step.name ?? names.named("click", undefined, "element") }) },
          [e.id],
          { kind: "other" },
        );
        break;
      }
      case "navigate": {
        const path = pathOf(e.url);
        scrollY = 0;
        mergeFrom = steps.length;
        if (!e.afterAction) {
          // A redirect: move the last URL wait/check to where it landed, or drop them for a wait before the next
          // action when it lands on `/` or back where it started (spec 5.3).
          const prev = last();
          if (prev && prev.meta.kind === "url" && path !== currentPath) {
            const wait = steps[prev.i - 1];
            const pair = wait && wait.action === "waitForUrl" && meta[prev.i - 1]!.kind === "url";
            if (path === "/" || path === urlFromPath) {
              const ids = [...(pair ? sources[prev.i - 1]! : []), ...sources[prev.i]!];
              const drop = pair ? 2 : 1;
              steps.splice(-drop);
              sources.splice(-drop);
              meta.splice(-drop);
              nextId -= drop;
              mergeFrom = steps.length;
              waitBeforeNext = [...new Set([...ids, e.id])];
            } else {
              const expected = `*${path}*`;
              replaceLast({ ...prev.step, expected }, [e.id]);
              if (pair) {
                steps[prev.i - 1] = { ...wait, expected };
                sources[prev.i - 1]!.push(e.id);
              }
            }
          } else if (waitBeforeNext) waitBeforeNext.push(e.id);
          currentPath = path;
          break;
        }
        if (path === "/" || path === currentPath) waitBeforeNext = [e.id];
        else {
          const expected = `*${path}*`;
          urlFromPath = currentPath;
          push({ action: "waitForUrl", name: names.t("waitForUrl", { path }), expected, timeout: NAVIGATION_TIMEOUT_MS }, [e.id], { kind: "url", at: e.at });
          push({ action: "assertUrl", name: names.t("checkUrl", { path }), expected }, [e.id], { kind: "url", at: e.at });
          waitBeforeNext = undefined;
        }
        currentPath = path;
        break;
      }
      case "scroll": {
        if (e.frame.isSubframe) break;
        const prev = last();
        let base = scrollY;
        const ids = [e.id];
        if (prev && prev.meta.kind === "scroll" && !prev.meta.scrollBottom) {
          // Consecutive stops keep only the last; bottom stops are kept each time (infinite lists).
          base = prev.meta.scrollBase ?? 0;
          ids.unshift(...sources[prev.i]!);
          steps.pop();
          sources.pop();
          meta.pop();
          nextId--;
        }
        let value: string | undefined;
        if (e.atBottom) value = "bottom";
        else if (e.atTop) value = base === 0 ? undefined : "top";
        else {
          const diff = Math.round(e.y - base);
          value = diff === 0 ? undefined : String(diff);
        }
        scrollY = e.atTop ? 0 : e.y;
        if (value === undefined) break;
        const name = value === "bottom" ? names.t("scrollBottom") : value === "top" ? names.t("scrollTop") : names.t("scrollBy", { px: value });
        push({ action: "scroll", name, value }, ids, { kind: "scroll", at: e.at, scrollBottom: value === "bottom", scrollBase: base });
        break;
      }
      case "popupClose":
        break;
    }
  }

  if (popup) {
    push({ action: "closePopup", name: names.t("closePopup") }, [popup.openId], { kind: "other", at: 0 });
    warn("popupNotClosed", [popup.openId]);
  }
  push({ action: "screenshot", name: names.t("finalScreen") }, [], { kind: "other", at: 0 });

  return { steps, sourceEventIds: sources, warnings, origin, eventCount: events.length, device: options.device };
}

function inputName(names: ReturnType<typeof stepNames>, target: ElementInfo, isPassword: boolean): string {
  if (isPassword) return names.named("fill", target.placeholder, "password");
  return names.named("fill", target.placeholder ?? target.text, "field");
}
