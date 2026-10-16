// Recording control, main process side (stage 4 contract section 7, desktop spec 5.1 and 5.6). Electron-free:
// the side browser feeds it tab events and its own navigation and window events; it keeps the raw events,
// re-numbers them, and converts the whole list again after every change.
import { messages, type Locale } from "@defe2end/i18n";
import { rawEventSchema, type ConvertOptions, type RawEvent, type RecordingDevice, type RecordingResult } from "@defe2end/recorder";

/** Context menu labels in the app language, in the collector's order (visible, visible warn only, text, hover). */
export function menuLabels(locale: Locale): [string, string, string, string] {
  const menu = messages[locale].recorder.menu;
  return [menu.checkVisible, menu.checkVisibleOrWarn, menu.checkText, menu.hover];
}

export type { Locale };

export interface RecordingOptions {
  startTabId: string;
  startUrl: string;
  device: RecordingDevice;
  testAttributes: string[];
  locale: Locale;
  convert(events: readonly RawEvent[], options: ConvertOptions): RecordingResult;
  /** Main process clock (epoch ms). */
  now?(): number;
}

/** Tab events whose next main-frame navigation counts as caused by them. */
const ACTIONS = new Set(["click", "input", "key", "select"]);

export class Recording {
  private readonly events: RawEvent[] = [];
  private seq = 0;
  /** Tabs whose last event since their last navigation was an action. */
  private readonly actedSinceNavigation = new Set<string>();
  private readonly lastUrl = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly opts: RecordingOptions) {
    this.now = opts.now ?? Date.now;
  }

  get lastEvent(): RawEvent | undefined {
    return this.events.at(-1);
  }

  get device(): RecordingDevice {
    return this.opts.device;
  }

  /**
   * A raw event from a tab's preload. The tab is not trusted with ordering or identity: `id`, `tabId`, `at`
   * and `pageUrl` are the main process's. Returns false when the payload isn't a raw event.
   */
  fromTab(tabId: string, topUrl: string, payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null) return false;
    const stamped = { ...payload, ...this.stamp(tabId, topUrl) } as Record<string, unknown>;
    // A dialog is reported when it closes; date it at its opening so it can join the click that opened it.
    if (stamped.type === "dialog" && typeof stamped.openMs === "number" && stamped.openMs >= 0) stamped.at = Math.max(0, (stamped.at as number) - Math.floor(stamped.openMs));
    const parsed = rawEventSchema.safeParse(stamped);
    if (!parsed.success) return false;
    this.push(parsed.data);
    if (ACTIONS.has(parsed.data.type)) this.actedSinceNavigation.add(tabId);
    return true;
  }

  /** Main-frame navigation of a tab (not the reload of a device switch, which recording forbids anyway). */
  navigate(tabId: string, url: string, kind: "document" | "in-page" = "document"): void {
    // A document load is always a navigation, a reload of the same URL included. An in-page notice for the URL
    // the tab is already on (pushState/replaceState or a hash set to the same value) changed nothing.
    if (kind === "in-page" && this.lastUrl.get(tabId) === url) return;
    this.lastUrl.set(tabId, url);
    const afterAction = this.actedSinceNavigation.delete(tabId);
    this.add({ type: "navigate", url, afterAction, frame: { isSubframe: false, url } }, tabId, url);
  }

  popupOpen(openerTabId: string, tabId: string, url: string): void {
    this.add({ type: "popupOpen", openerTabId, url, frame: { isSubframe: false, url } }, tabId, url);
  }

  popupClose(tabId: string, url: string): void {
    this.add({ type: "popupClose", frame: { isSubframe: false, url } }, tabId, url);
  }

  /** Deleting a step in the web panel drops the events that made it (desktop spec 5.6). */
  discard(eventIds: readonly string[]): void {
    const drop = new Set(eventIds);
    for (let i = this.events.length - 1; i >= 0; i--) if (drop.has(this.events[i]!.id)) this.events.splice(i, 1);
  }

  result(): RecordingResult {
    const { startTabId, startUrl, device, testAttributes, locale } = this.opts;
    return this.opts.convert(this.events, { startTabId, startUrl, device, testAttributes, locale });
  }

  private stamp(tabId: string, topUrl: string) {
    return { id: `e${++this.seq}`, tabId, at: this.now(), pageUrl: topUrl };
  }

  private add(event: Record<string, unknown> & { type: RawEvent["type"] }, tabId: string, topUrl: string): void {
    const parsed = rawEventSchema.safeParse({ ...event, ...this.stamp(tabId, topUrl) });
    if (parsed.success) this.push(parsed.data);
  }

  private push(event: RawEvent): void {
    this.events.push(event);
  }
}
