// Side browser (stage 4 contract section 6, desktop spec 4) and the main process half of recording (section 7).
// Tabs are WebContentsViews in the main window, all in one persistent partition kept apart from the server UI.
import path from "node:path";
import { session, WebContentsView, type BrowserWindow, type Rectangle, type WebContents } from "electron";
import { convert, type RecordingResult } from "@defe2end/recorder";
import type { StorageState } from "@defe2end/shared";
import { READ_LOCAL_STORAGE, siteStorageState } from "./core/auth-state.js";
import { messages } from "@defe2end/i18n";
import { isFindShortcut, matchLabel, parseFindQuery } from "./core/find.js";
import { menuLabels, Recording, type Locale } from "./core/recording.js";

export const SIDE_BROWSER_PARTITION = "persist:defe2end-target";

export type DeviceView = "desktop" | "mobile";
const HUD_SIZE = { width: 260, height: 64 };
const FIND_SIZE = { width: 380, height: 44 };
/** Mobile view (desktop spec 4): a 360×780 phone. */
const MOBILE = {
  width: 360,
  height: 780,
  deviceScaleFactor: 3,
  userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
};

interface Tab {
  id: string;
  view: WebContentsView;
  /** Tab that opened this one (new window requests), for the recording's popup lineage. */
  openerId: string | null;
}

export interface SideBrowserOptions {
  window: BrowserWindow;
  /** `connected.recorder.testAttributes` of the current connection. */
  testAttributes(): string[];
  locale(): Locale;
  /** Sends to the web UI (server page only). */
  emit(channel: "sideBrowser:tabs" | "recorder:result" | "recorder:checkRequested" | "sideBrowser:openRequested" | "sideBrowser:aiActive", payload: unknown): void;
  log(message: string): void;
}

const isWeb = (url: string) => /^https?:\/\//i.test(url);

export class SideBrowser {
  private readonly tabs = new Map<string, Tab>();
  private activeId: string | null = null;
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private seq = 0;
  private recording: Recording | null = null;
  private visible = false;
  private device: DeviceView = "desktop";
  /** The web UI is dragging a panel edge: tabs hide until it ends. */
  private dragging = false;
  /** Recording card over the active tab (desktop spec 5.1). */
  private hud: WebContentsView | null = null;
  private hudState: unknown = { count: 0, lastName: null, lastAction: null };
  /** Find bar over the active tab (desktop spec 4), and the tab it searches. */
  private findBar: WebContentsView | null = null;
  private findTabId: string | null = null;
  private findText = "";

  constructor(private readonly opts: SideBrowserOptions) {}

  /** The tab id of a side browser webContents, or null: IPC from anything else is refused. */
  tabIdOf(contents: WebContents): string | null {
    for (const tab of this.tabs.values()) if (tab.view.webContents === contents) return tab.id;
    return null;
  }

  open(url: string | undefined, bounds: Rectangle): void {
    this.bounds = bounds;
    this.visible = true;
    // Coming back reuses the tab as it was; the URL doesn't overwrite it.
    if (this.tabs.size === 0) this.addTab(url && isWeb(url) ? url : "about:blank", null);
    this.layout();
  }

  /** Detaches and closes every tab; the partition (logins) stays. */
  /** The find bar's webContents: its IPC is the only find IPC heard. */
  isFindBar(contents: WebContents): boolean {
    return !!this.findBar && this.findBar.webContents === contents;
  }

  /** ⌘F/Ctrl+F in the active tab: opens the bar (or focuses it again). */
  openFind(): void {
    const tab = this.active();
    if (!tab || !this.visible) return;
    if (this.findBar && this.findTabId === tab.id) {
      this.findBar.webContents.focus();
      this.findBar.webContents.send("find:focus");
      return;
    }
    this.closeFind();
    const text = messages[this.opts.locale()].settings.desktopApp;
    const bar = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, "find-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
    });
    bar.setBackgroundColor("#00000000");
    bar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    bar.webContents.on("will-navigate", (event) => event.preventDefault());
    bar.webContents.on("did-finish-load", () => {
      bar.webContents.send("find:labels", { placeholder: text.findPlaceholder, previous: text.findPrevious, next: text.findNext, close: text.findClose });
      bar.webContents.focus();
      bar.webContents.send("find:focus");
    });
    this.findBar = bar;
    this.findTabId = tab.id;
    this.findText = "";
    void bar.webContents.loadFile(path.join(__dirname, "..", "static", "find.html"));
    this.layout();
  }

  /** `find:query` from the bar. Typing there is not a page event, so recording never sees it. */
  onFindQuery(contents: WebContents, payload: unknown): void {
    const query = parseFindQuery(payload);
    const tab = this.findTabId ? this.tabs.get(this.findTabId) : undefined;
    if (!this.isFindBar(contents) || !query || !tab) return;
    const page = tab.view.webContents;
    if (!query.text) {
      page.stopFindInPage("clearSelection");
      this.findText = "";
      this.findBar?.webContents.send("find:result", "");
      return;
    }
    const findNext = query.findNext && query.text === this.findText;
    this.findText = query.text;
    page.findInPage(query.text, { forward: query.forward, findNext });
  }

  /** Esc or the close button in the bar; also on tab change and closing the side browser. */
  closeFind(): void {
    const bar = this.findBar;
    if (!bar) return;
    const tab = this.findTabId ? this.tabs.get(this.findTabId) : undefined;
    if (tab && !tab.view.webContents.isDestroyed()) tab.view.webContents.stopFindInPage("clearSelection");
    this.findBar = null;
    this.findTabId = null;
    this.findText = "";
    this.opts.window.contentView.removeChildView(bar);
    if (!bar.webContents.isDestroyed()) bar.webContents.close();
  }

  close(): void {
    this.closeFind();
    if (this.recording) this.stopRecording();
    for (const tab of this.tabs.values()) this.destroy(tab);
    this.tabs.clear();
    this.activeId = null;
    this.visible = false;
    this.emitTabs();
  }

  /** Minimize: hide, keep the tabs alive. */
  setDragging(dragging: boolean): void {
    this.dragging = dragging;
    this.layout();
  }

  hide(): void {
    this.visible = false;
    this.layout();
  }

  setBounds(bounds: Rectangle): void {
    this.bounds = bounds;
    this.layout();
  }

  navigate(url: string): void {
    const tab = this.active();
    if (tab && isWeb(url)) void tab.view.webContents.loadURL(url);
  }

  select(tabId: string): void {
    if (!this.tabs.has(tabId)) return;
    if (tabId !== this.activeId) this.closeFind();
    this.activeId = tabId;
    this.layout();
    this.emitTabs();
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.recording?.popupClose(tab.id, tab.view.webContents.getURL());
    if (this.findTabId === tabId || this.activeId === tabId) this.closeFind();
    this.destroy(tab);
    this.tabs.delete(tabId);
    if (this.activeId === tabId) this.activeId = [...this.tabs.keys()].at(-1) ?? null;
    this.layout();
    this.emitTabs();
    this.publish();
  }

  /** Switches every tab between desktop and mobile view and reloads it. Refused while recording. */
  async setDevice(device: DeviceView): Promise<boolean> {
    if (this.recording) return false;
    if (device === this.device) return true;
    this.device = device;
    for (const tab of this.tabs.values()) {
      await this.applyDevice(tab.view.webContents);
      tab.view.webContents.reload();
    }
    return true;
  }

  get currentDevice(): DeviceView {
    return this.device;
  }

  openDevTools(): void {
    this.active()?.view.webContents.openDevTools({ mode: "detach" });
  }

  /**
   * "Save this site's login": the active tab's host and parent-domain cookies and its origin's localStorage.
   * Null when the site has no cookie yet (the user should sign in first).
   */
  async siteSession(): Promise<StorageState | null> {
    const contents = this.active()?.view.webContents;
    if (!contents) return null;
    const cookies = await session.fromPartition(SIDE_BROWSER_PARTITION).cookies.get({});
    const local = (await contents.executeJavaScript(READ_LOCAL_STORAGE).catch(() => null)) as { name: string; value: string }[] | null;
    return siteStorageState(contents.getURL(), cookies, Array.isArray(local) ? local : null);
  }

  /** CDP emulation; attached before a new tab's first request so that request is already "mobile". */
  private async applyDevice(contents: WebContents): Promise<void> {
    try {
      const dbg = contents.debugger;
      if (!dbg.isAttached()) dbg.attach("1.3");
      if (this.device === "mobile") {
        await dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width: MOBILE.width, height: MOBILE.height, deviceScaleFactor: MOBILE.deviceScaleFactor, mobile: true });
        await dbg.sendCommand("Emulation.setUserAgentOverride", { userAgent: MOBILE.userAgent });
        await dbg.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      } else {
        await dbg.sendCommand("Emulation.clearDeviceMetricsOverride");
        await dbg.sendCommand("Emulation.setUserAgentOverride", { userAgent: contents.session.getUserAgent() });
        await dbg.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false });
      }
    } catch (err) {
      this.opts.log(`device view not applied: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Recording -----------------------------------------------------------------

  get isRecording(): boolean {
    return this.recording !== null;
  }

  /** Records the start tab, its URL and the current device view (which can't change until stop). */
  startRecording(): RecordingResult | null {
    const tab = this.active();
    if (!tab || this.recording) return null;
    this.recording = new Recording({
      startTabId: tab.id,
      startUrl: tab.view.webContents.getURL(),
      device: this.device,
      testAttributes: this.opts.testAttributes(),
      locale: this.opts.locale(),
      convert,
    });
    for (const t of this.tabs.values()) this.pushState(t);
    this.showHud();
    return this.publish();
  }

  stopRecording(): RecordingResult | null {
    const recording = this.recording;
    if (!recording) return null;
    const result = recording.result();
    this.recording = null;
    for (const t of this.tabs.values()) this.pushState(t);
    this.closeHud();
    return result;
  }

  discard(eventIds: readonly string[]): RecordingResult | null {
    this.recording?.discard(eventIds);
    return this.publish();
  }

  /** `recorder:event` from a tab preload (any frame). */
  onTabEvent(contents: WebContents, payload: unknown): void {
    const tabId = this.tabIdOf(contents);
    if (!tabId || !this.recording) return;
    if (this.recording.fromTab(tabId, contents.getURL(), payload)) {
      // A check picked from the right-click menu: the web panel shows it as a request to add a check.
      const last = this.recording.lastEvent;
      if (last?.type === "contextmenu") this.opts.emit("recorder:checkRequested", { eventId: last.id, check: last.check, text: last.text ?? null, selector: last.target.selectors[0] ?? null });
      this.publish();
    } else this.opts.log(`recorder event refused from tab ${tabId}: not a raw event`);
  }

  private publish(): RecordingResult | null {
    if (!this.recording) return null;
    const result = this.recording.result();
    this.opts.emit("recorder:result", result);
    const last = result.steps.at(-1);
    this.hudState = { count: result.steps.length, lastName: last?.name ?? null, lastAction: last?.action ?? null };
    this.hud?.webContents.send("hud:update", this.hudState);
    return result;
  }

  /** Every frame has its own preload, so the state goes to each one (and again after each load). */
  private pushState(tab: Tab): void {
    const state = { recording: this.recording !== null, tabId: tab.id, testAttributes: this.opts.testAttributes(), menuLabels: menuLabels(this.opts.locale()) };
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    for (const frame of contents.mainFrame.framesInSubtree) {
      try {
        frame.send("recorder:state", state);
      } catch {
        // The frame went away meanwhile.
      }
    }
  }

  // --- AI browser tools (stage 6 contract section 5) -------------------------------

  get hasTabs(): boolean {
    return this.tabs.size > 0;
  }

  /** Asks the web UI to show the panel (it owns the bounds). */
  requestOpen(): void {
    this.opts.emit("sideBrowser:openRequested", null);
  }

  aiTabs(): { id: string; url: string; title: string; active: boolean }[] {
    return [...this.tabs.values()].map((t) => ({ id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle(), active: t.id === this.activeId }));
  }

  /** The tab's (default: active tab's) contents. */
  aiContents(tabId?: string): WebContents | null {
    const tab = tabId ? this.tabs.get(tabId) : this.active();
    return tab && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
  }

  aiNewTab(url: string): string {
    const tab = this.addTab(url, null);
    this.layout();
    this.emitTabs();
    return tab.id;
  }

  /** The "AI is operating" sign, shown by the web UI over the panel. */
  setAiActive(active: boolean): void {
    this.opts.emit("sideBrowser:aiActive", active);
  }

  // --- Tabs ----------------------------------------------------------------------

  private active(): Tab | null {
    return this.activeId ? (this.tabs.get(this.activeId) ?? null) : null;
  }

  private addTab(url: string, openerId: string | null): Tab {
    const view = new WebContentsView({
      webPreferences: {
        partition: SIDE_BROWSER_PARTITION,
        preload: path.join(__dirname, "recorder-preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        webviewTag: false,
      },
    });
    const tab: Tab = { id: `tab-${++this.seq}`, view, openerId };
    this.tabs.set(tab.id, tab);
    this.closeFind();
    this.activeId = tab.id;
    const contents = view.webContents;
    // New windows open as tabs in the app, remembering who opened them.
    contents.setWindowOpenHandler(({ url: target }) => {
      if (isWeb(target)) {
        const child = this.addTab(target, tab.id);
        this.recording?.popupOpen(tab.id, child.id, target);
        this.layout();
        this.emitTabs();
        this.publish();
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, target) => {
      if (!isWeb(target)) event.preventDefault();
    });
    const navigated = (target: string, kind: "document" | "in-page") => {
      this.recording?.navigate(tab.id, target, kind);
      this.publish();
      this.emitTabs();
    };
    contents.on("did-navigate", (_event, target) => navigated(target, "document"));
    // SPA pushState and hash changes of the top frame.
    contents.on("did-navigate-in-page", (_event, target, isMainFrame) => {
      if (isMainFrame) navigated(target, "in-page");
    });
    contents.on("did-frame-finish-load", () => this.pushState(tab));
    // ⌘F/Ctrl+F is taken here, before the page: it never reaches the page (or the recorder).
    contents.on("before-input-event", (event, input) => {
      if (!isFindShortcut(input, process.platform)) return;
      event.preventDefault();
      this.openFind();
    });
    contents.on("found-in-page", (_event, result) => {
      if (this.findTabId !== tab.id) return;
      const noMatches = messages[this.opts.locale()].settings.desktopApp.findNoMatches;
      this.findBar?.webContents.send("find:result", matchLabel(result, noMatches));
    });
    contents.on("page-title-updated", () => this.emitTabs());
    contents.on("render-process-gone", (_event, details) => this.opts.log(`side browser tab ${tab.id} gone: ${details.reason}`));
    this.opts.window.contentView.addChildView(view);
    void this.applyDevice(contents).finally(() => void contents.loadURL(url));
    return tab;
  }

  private destroy(tab: Tab): void {
    this.opts.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  private layout(): void {
    for (const tab of this.tabs.values()) {
      const show = this.visible && !this.dragging && tab.id === this.activeId;
      tab.view.setVisible(show);
      if (show) tab.view.setBounds(this.bounds);
    }
    const right = (width: number) => this.bounds.x + Math.max(0, this.bounds.width - width - 12);
    let top = this.bounds.y + 12;
    if (this.findBar) {
      const show = this.visible && !this.dragging;
      this.findBar.setVisible(show);
      if (show) {
        // Re-adding keeps it above tabs added since.
        this.opts.window.contentView.addChildView(this.findBar);
        this.findBar.setBounds({ x: right(FIND_SIZE.width), y: top, ...FIND_SIZE });
        top += FIND_SIZE.height + 8;
      }
    }
    if (this.hud) {
      const show = this.visible && !this.dragging;
      this.hud.setVisible(show);
      if (show) {
        this.opts.window.contentView.addChildView(this.hud);
        this.hud.setBounds({ x: right(HUD_SIZE.width), y: top, ...HUD_SIZE });
      }
    }
  }

  /** A small local view with its own minimal preload; it only ever receives `hud:update`. */
  private showHud(): void {
    if (this.hud) return;
    const hud = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, "hud-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
    });
    hud.setBackgroundColor("#00000000");
    hud.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    hud.webContents.on("will-navigate", (event) => event.preventDefault());
    hud.webContents.on("did-finish-load", () => hud.webContents.send("hud:update", this.hudState));
    this.hud = hud;
    void hud.webContents.loadFile(path.join(__dirname, "..", "static", "hud.html"), { query: { locale: this.opts.locale() } });
    this.layout();
  }

  private closeHud(): void {
    const hud = this.hud;
    if (!hud) return;
    this.hud = null;
    this.opts.window.contentView.removeChildView(hud);
    if (!hud.webContents.isDestroyed()) hud.webContents.close();
  }

  private emitTabs(): void {
    this.opts.emit("sideBrowser:tabs", {
      activeId: this.activeId,
      tabs: [...this.tabs.values()].map((t) => ({ id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle(), openerId: t.openerId })),
    });
  }
}

/** Settings → "clear side browser data", and every generation change (contract section 9). */
export function clearSideBrowserData(): Promise<void> {
  return session.fromPartition(SIDE_BROWSER_PARTITION).clearStorageData();
}
