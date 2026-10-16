import { bundledBrowserPath } from "./bundled-browser.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { RUNNER_VERSION, runPlan } from "@defe2end/runner";
import { messages } from "@defe2end/i18n";
import { DEFAULT_DEVICE, DESKTOP_LABEL_MAX, type AppUpdateRequired } from "@defe2end/shared";
import type { DesktopIdentity } from "./core/api-client.js";
import { ConnectionManager, type ConnectionState } from "./core/connection.js";
import type { RunProgress } from "./core/executor.js";
import { isServerSender, isSetupSender, mainWindowNavigation, parseAuthOrigins, type SenderFacts } from "./core/guards.js";
import { checkServer, normalizeServerUrl } from "./core/server-url.js";
import { CaptureController, READ_LOCAL_STORAGE, registerAuthSession, toStorageCookie, type CaptureWindow } from "./core/auth-state.js";
import { clearSideBrowserData, SIDE_BROWSER_PARTITION, SideBrowser } from "./side-browser.js";
// Stage 6 MCP (socket, relay, registration).
import { execFile } from "node:child_process";
import os from "node:os";
import { McpHost } from "./core/mcp-host.js";
import { safeStorageMcpTokenStore } from "./mcp-host.js";
import { mcpCommand, mcpScriptPath, register as registerMcp, registrationOf, type McpCli, type RunCli } from "./mcp-command.js";
import { sideBrowserDriver } from "./side-browser-driver.js";
import { ChatManager } from "./core/ai/chat.js";
import { detectAll, userShellPath, type ProviderStatus } from "./core/ai/detect.js";
import type { McpServerSpec } from "./core/ai/launch.js";

const pagePath = path.join(__dirname, "..", "static", "index.html");
const pageUrl = pathToFileURL(pagePath).href;
/** Server paths where being on the page doesn't mean being signed in. */
const SIGNED_OUT_PATHS = /^\/(login|signup|setup|api\/auth)(\/|$)/;

interface AppSettings {
  /** "Hide the browser" for PC runs (contract 4.4.1). Local to this PC, never sent to the server. */
  hideBrowser: boolean;
  installId: string;
  /** Random 4 characters, or the user's alias (display only). */
  label: string;
  serverOrigin: string | null;
}

let mainWindow: BrowserWindow | null = null;
/** Set by a quit that is waiting for the main window to close (its unsaved-changes check may cancel it). */
let quitAfterClose = false;
let settings: AppSettings;
let authOrigins: string[] = [];
let manager: ConnectionManager;
let sideBrowser: SideBrowser | null = null;
let captures: CaptureController;
/** `connected.recorder.testAttributes` of the current connection. */
let testAttributes: string[] = [];
const appLocale = () => (app.getLocale().toLowerCase().startsWith("ko") ? "ko" : "en");

const dataDir = () => app.getPath("userData");
const settingsFile = () => path.join(dataDir(), "settings.json");
const tokenFile = () => path.join(dataDir(), "token.bin");
const log = (message: string) => console.log(`[defe2end] ${message}`);

async function loadSettings(): Promise<AppSettings> {
  try {
    const saved = JSON.parse(await readFile(settingsFile(), "utf8")) as Partial<AppSettings>;
    if (typeof saved.installId === "string" && typeof saved.label === "string") {
      return { hideBrowser: saved.hideBrowser === true, installId: saved.installId, label: saved.label, serverOrigin: typeof saved.serverOrigin === "string" ? normalizeServerUrl(saved.serverOrigin) : null };
    }
  } catch {
    // First run.
  }
  const fresh = { hideBrowser: false, installId: randomUUID(), label: randomBytes(3).toString("base64url").slice(0, 4), serverOrigin: null };
  await saveSettings(fresh);
  return fresh;
}

async function saveSettings(next: AppSettings): Promise<void> {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  await writeFile(settingsFile(), JSON.stringify(next), { mode: 0o600 });
}

// The token lives only in the OS secure store (safeStorage); no store, no saved token.
async function loadToken(origin: string): Promise<DesktopIdentity | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const saved = JSON.parse(safeStorage.decryptString(await readFile(tokenFile()))) as DesktopIdentity & { origin: string };
    return saved.origin === origin && Date.parse(saved.expiresAt) > Date.now() ? saved : null;
  } catch {
    return null;
  }
}

async function saveToken(origin: string, identity: DesktopIdentity): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) return;
  await writeFile(tokenFile(), safeStorage.encryptString(JSON.stringify({ ...identity, origin })), { mode: 0o600 });
}

async function loadAuthOrigins(origin: string): Promise<void> {
  try {
    const res = await fetch(`${origin}/api/desktop/config`, { signal: AbortSignal.timeout(10_000) });
    authOrigins = parseAuthOrigins(((await res.json()) as { authOrigins?: unknown }).authOrigins);
  } catch (err) {
    authOrigins = [];
    log(`desktop config unavailable: ${String(err)}`);
  }
}

function senderFacts(event: IpcMainInvokeEvent): SenderFacts {
  const frame = event.senderFrame;
  return { fromMainWindow: !!mainWindow && event.sender === mainWindow.webContents, isMainFrame: !!frame && frame.parent === null, frameUrl: frame?.url ?? "" };
}

/** Every handler checks its sender; refusals are logged and answered with nothing. */
function handle(channel: string, allowed: (facts: SenderFacts) => boolean, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    const facts = senderFacts(event);
    if (!allowed(facts)) {
      log(`IPC ${channel} refused from ${facts.frameUrl || "unknown frame"}`);
      return undefined;
    }
    return fn(...args);
  });
}

const fromServer = (facts: SenderFacts) => isServerSender(facts, manager.serverOrigin);
const fromSetup = (facts: SenderFacts) => isSetupSender(facts, pageUrl);

function send(channel: string, payload: unknown): void {
  const contents = mainWindow?.webContents;
  if (!contents || contents.isDestroyed()) return;
  // Only to the server page: the setup page and sign-in pages never get connection or run data.
  if (isServerSender({ fromMainWindow: true, isMainFrame: true, frameUrl: contents.getURL() }, manager.serverOrigin)) contents.send(channel, payload);
}

function lockDown(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (mainWindowNavigation(url, manager.serverOrigin, authOrigins) === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (!manager.serverOrigin && url.startsWith("file:")) {
      if (!isSetupSender({ fromMainWindow: true, isMainFrame: true, frameUrl: url }, pageUrl)) event.preventDefault();
      return;
    }
    const decision = mainWindowNavigation(url, manager.serverOrigin, authOrigins);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") void shell.openExternal(url);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.on("will-attach-webview", (event) => event.preventDefault());
  const maybeConnect = (_event: unknown, url: string) => {
    const origin = manager.serverOrigin;
    if (!origin) return;
    try {
      const u = new URL(url);
      if (u.origin === origin && !SIGNED_OUT_PATHS.test(u.pathname)) void manager.connect();
    } catch {
      // Not a URL: nothing to do.
    }
  };
  contents.on("did-navigate", maybeConnect);
  contents.on("did-navigate-in-page", maybeConnect);
}

function denyPermissions(ses: Electron.Session): void {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
}

function showHome(): void {
  if (!mainWindow) return;
  const origin = manager.serverOrigin;
  if (origin) void mainWindow.loadURL(origin);
  else void mainWindow.loadFile(pagePath);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "defE2End",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  lockDown(mainWindow.webContents);
  // The web editor's `beforeunload` guard: Electron cancels the close, reload or quit silently unless we ask.
  mainWindow.webContents.on("will-prevent-unload", (event) => {
    const text = messages[appLocale()].settings.desktopApp;
    const response = dialog.showMessageBoxSync(mainWindow!, {
      type: "question",
      message: text.unsavedTitle,
      detail: text.unsavedDetail,
      buttons: [text.unsavedLeave, text.unsavedStay],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) event.preventDefault();
    else quitAfterClose = false;
  });
  sideBrowser = new SideBrowser({ window: mainWindow, testAttributes: () => testAttributes, locale: appLocale, emit: send, log });
  mainWindow.on("closed", () => {
    sideBrowser = null;
    mainWindow = null;
    if (quitAfterClose) app.quit();
  });
  showHome();
}

let updateDialogShown = false;
async function showUpdateRequired(body: AppUpdateRequired): Promise<void> {
  if (updateDialogShown) return;
  updateDialogShown = true;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "업데이트가 필요해요",
    message: "업데이트가 필요해요",
    detail: `이 버전(v${app.getVersion()})은 이 서버에서 더 이상 쓸 수 없어요.${body.minimum ? ` v${body.minimum} 이상을 설치하세요.` : ""}`,
    buttons: ["다운로드 페이지 열기", "종료"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await shell.openExternal(body.downloadUrl ?? "https://github.com/defe2end/defe2end/releases");
  app.quit();
}

/** A visible browser in its own in-memory partition, for signing in to the target site (contract section 5). */
function openCaptureWindow(url: string): CaptureWindow {
  const partition = `defe2end-capture-${randomUUID()}`;
  const ses = session.fromPartition(partition);
  denyPermissions(ses);
  const win = new BrowserWindow({ width: 1200, height: 820, title: "defE2End", webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void win.loadURL(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!/^https?:/i.test(target)) event.preventDefault();
  });
  let closing: (() => Promise<void>) | null = null;
  let finishing = false;
  win.on("close", (event) => {
    if (finishing || !closing) return;
    // Take the last snapshot before the page goes away, then close for real.
    event.preventDefault();
    finishing = true;
    void closing().finally(() => {
      if (!win.isDestroyed()) win.destroy();
    });
  });
  win.on("closed", () => void ses.clearStorageData());
  if (/^https?:/i.test(url)) void win.loadURL(url);
  return {
    async snapshot() {
      if (win.isDestroyed()) return null;
      const cookies = (await ses.cookies.get({})).map(toStorageCookie);
      const page = win.webContents.getURL();
      const local = (await win.webContents.executeJavaScript(READ_LOCAL_STORAGE).catch(() => null)) as { name: string; value: string }[] | null;
      const origin = /^https?:/i.test(page) ? new URL(page).origin : null;
      return { cookies, origins: origin && Array.isArray(local) && local.length ? [{ origin, localStorage: local }] : [] };
    },
    onClosing(listener) {
      closing = listener;
    },
    close() {
      finishing = true;
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

const isKo = () => appLocale() === "ko";

/** Settings: clears the side browser's partition (target-site logins) after a confirmation. */
async function confirmClearSideBrowser(): Promise<boolean> {
  const options = {
    type: "question" as const,
    message: isKo() ? "사이드 브라우저 데이터를 지울까요?" : "Clear side browser data?",
    detail: isKo() ? "사이드 브라우저의 쿠키·저장소가 지워지고 대상 사이트에서 로그아웃돼요. 서버에 저장한 로그인 세션은 그대로예요." : "Cookies and storage of the side browser are removed and you are signed out of target sites. Login sessions saved on the server stay.",
    buttons: isKo() ? ["지우기", "취소"] : ["Clear", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  };
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  if (response !== 0) return false;
  sideBrowser?.close();
  await clearSideBrowserData();
  return true;
}

/** Server change screen: the bundled first-run page again, with a way back. The switch happens on save. */
function showChangeServer(): void {
  void mainWindow?.loadFile(pagePath, { query: { change: "1", current: manager.serverOrigin ?? "" } });
}

/** Takes effect from the next run; a running one keeps its mode. */
async function setHideBrowser(value: boolean): Promise<boolean> {
  settings = { ...settings, hideBrowser: value };
  await saveSettings(settings);
  buildMenu();
  return value;
}

function buildMenu(): void {
  const text = messages[appLocale()].settings.desktopApp;
  const settingsItems: Electron.MenuItemConstructorOptions[] = [
    { label: text.hideBrowser, toolTip: text.hideBrowserHint, type: "checkbox", checked: settings.hideBrowser, click: (item) => void setHideBrowser(item.checked) },
    { label: isKo() ? "서버 주소 바꾸기…" : "Change server address…", click: () => showChangeServer() },
    { label: isKo() ? "사이드 브라우저 데이터 지우기…" : "Clear side browser data…", click: () => void confirmClearSideBrowser() },
  ];
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const, submenu: [{ role: "about" as const }, { type: "separator" as const }, ...settingsItems, { type: "separator" as const }, { role: "hide" as const }, { role: "hideOthers" as const }, { role: "unhide" as const }, { type: "separator" as const }, { role: "quit" as const }] }] : [{ label: isKo() ? "파일" : "File", submenu: [...settingsItems, { type: "separator" as const }, { role: "quit" as const }] }]),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc(): void {
  ipcMain.on("app:version", (event) => {
    const facts = { fromMainWindow: !!mainWindow && event.sender === mainWindow.webContents, isMainFrame: event.senderFrame?.parent === null, frameUrl: event.senderFrame?.url ?? "" };
    event.returnValue = fromSetup(facts) || fromServer(facts) ? app.getVersion() : "";
  });

  handle("setup:check", fromSetup, async (input) => {
    const origin = typeof input === "string" ? normalizeServerUrl(input) : null;
    if (!origin) return { ok: false, reason: "invalid" };
    const check = await checkServer(origin);
    return check.ok ? { ok: true, origin, version: check.version } : check;
  });
  handle("setup:save", fromSetup, async (input) => {
    const origin = typeof input === "string" ? normalizeServerUrl(input) : null;
    if (!origin || !(await checkServer(origin)).ok) return { ok: false };
    if (origin === manager.serverOrigin) {
      showHome();
      return { ok: true };
    }
    // Contract section 9: the old server's stream, runs, token, cookies and side browser data go first.
    await manager.changeServer(origin);
    settings = { ...settings, serverOrigin: origin };
    await saveSettings(settings);
    await loadAuthOrigins(origin);
    showHome();
    return { ok: true };
  });

  handle("connection:state", fromServer, () => publicState(manager.state));
  handle("connection:connect", fromServer, () => manager.connect());
  handle("connection:disconnect", fromServer, () => manager.teardown("account_change"));
  handle("connection:logout", fromServer, async () => {
    await manager.teardown("logout");
    showHome();
  });
  handle("connection:setAlias", fromServer, async (alias) => {
    if (typeof alias !== "string") return;
    const trimmed = alias.replace(/\p{Cc}/gu, "").trim().slice(0, DESKTOP_LABEL_MAX);
    if (!trimmed) return;
    settings = { ...settings, label: trimmed };
    await saveSettings(settings);
  });

  const rect = (value: unknown): Electron.Rectangle | null => {
    const r = value as Record<string, unknown> | null;
    const ok = r && ["x", "y", "width", "height"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k]) && (r[k] as number) >= 0);
    return ok ? { x: Math.round(r.x as number), y: Math.round(r.y as number), width: Math.round(r.width as number), height: Math.round(r.height as number) } : null;
  };
  handle("sideBrowser:open", fromServer, (url, bounds) => {
    const r = rect(bounds);
    if (r) sideBrowser?.open(typeof url === "string" ? url : undefined, r);
  });
  handle("sideBrowser:close", fromServer, () => sideBrowser?.close());
  handle("sideBrowser:hide", fromServer, () => sideBrowser?.hide());
  handle("sideBrowser:setBounds", fromServer, (bounds) => {
    const r = rect(bounds);
    if (r) sideBrowser?.setBounds(r);
  });
  handle("sideBrowser:navigate", fromServer, (url) => typeof url === "string" && sideBrowser?.navigate(url));
  handle("sideBrowser:selectTab", fromServer, (id) => typeof id === "string" && sideBrowser?.select(id));
  handle("sideBrowser:closeTab", fromServer, (id) => typeof id === "string" && sideBrowser?.closeTab(id));
  handle("sideBrowser:clearData", fromServer, () => confirmClearSideBrowser());
  handle("sideBrowser:setDragging", fromServer, (dragging) => sideBrowser?.setDragging(dragging === true));

  handle("sideBrowser:setDevice", fromServer, (device) => (device === "mobile" || device === "desktop" ? (sideBrowser?.setDevice(device) ?? false) : false));
  handle("sideBrowser:openDevTools", fromServer, () => sideBrowser?.openDevTools());
  handle("sideBrowser:saveSession", fromServer, async (target) => {
    const t = target as { workspaceId?: unknown; environmentId?: unknown } | null;
    const api = manager.api;
    if (!api || typeof t?.workspaceId !== "string" || typeof t.environmentId !== "string") return { ok: false, reason: "not_connected" };
    const state = await sideBrowser?.siteSession();
    if (!state) return { ok: false, reason: "no_cookies" };
    log(`saving site login: ${state.cookies.length} cookies`);
    try {
      await registerAuthSession(api, { workspaceId: t.workspaceId, environmentId: t.environmentId, storageState: state });
      return { ok: true, cookieCount: state.cookies.length };
    } catch (err) {
      log(`site login not saved: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, reason: "register_failed" };
    }
  });

  handle("recorder:start", fromServer, () => sideBrowser?.startRecording() ?? null);
  handle("recorder:stop", fromServer, () => sideBrowser?.stopRecording() ?? null);
  handle("recorder:discard", fromServer, (ids) => (Array.isArray(ids) ? (sideBrowser?.discard(ids.filter((id): id is string => typeof id === "string")) ?? null) : null));
  // The find bar's own view only (desktop spec 4).
  ipcMain.on("find:query", (event, payload) => {
    if (!sideBrowser?.isFindBar(event.sender)) return log("find:query refused: not the find bar");
    sideBrowser.onFindQuery(event.sender, payload);
  });
  ipcMain.on("find:close", (event) => {
    if (!sideBrowser?.isFindBar(event.sender)) return log("find:close refused: not the find bar");
    sideBrowser.closeFind();
  });
  // Tab preloads (every frame): only known side browser tabs are heard.
  ipcMain.on("recorder:event", (event, payload) => {
    if (!sideBrowser || !sideBrowser.tabIdOf(event.sender)) {
      log("recorder:event refused: not a side browser tab");
      return;
    }
    sideBrowser.onTabEvent(event.sender, payload);
  });

  registerAiIpc();

  handle("app:changeServer", fromServer, () => showChangeServer());
  handle("setup:cancel", fromSetup, () => showHome());
  handle("app:getHideBrowser", fromServer, () => settings.hideBrowser);
  handle("app:setHideBrowser", fromServer, (value) => (typeof value === "boolean" ? setHideBrowser(value) : settings.hideBrowser));
}

// --- Stage 6 MCP (contract sections 5 and 6) ------------------------------------------------------------------
let mcpHost: McpHost | null = null;

/** GUI apps get a short PATH on mac; add the usual install places of the CLIs. */
const runCli: RunCli = (cli, args) =>
  new Promise((resolve, reject) => {
    const extra = process.platform === "win32" ? [] : [path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".npm-global", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    const env = { ...process.env, PATH: [process.env.PATH ?? "", ...extra].join(path.delimiter) };
    execFile(cli, args, { env, timeout: 20_000, windowsHide: true, shell: process.platform === "win32" }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout) });
    });
  });

function currentMcpCommand() {
  return mcpCommand({
    execPath: process.execPath,
    scriptPath: mcpScriptPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    mcpDir: mcpHost?.mcpDir ?? path.join(dataDir(), "mcp"),
  });
}

async function startMcp(): Promise<void> {
  mcpHost = new McpHost({
    userData: dataDir(),
    installId: settings.installId,
    state: () => manager.state,
    onState: (listener) => manager.onState(listener),
    desktopToken: () => manager.desktopToken,
    fetchWithCookies: (url, init) => session.defaultSession.fetch(String(url), { ...init, credentials: "include" } as RequestInit),
    fetch: (url, init) => fetch(url, init),
    driver: sideBrowserDriver(() => sideBrowser),
    tokenStore: safeStorageMcpTokenStore(path.join(dataDir(), "mcp-token.bin")),
    // A conversation started for another account or server must not continue as this one.
    onIdentityChange: () => chat?.stopAll(),
    log,
  });
  try {
    await mcpHost.start();
  } catch (err) {
    log(`mcp socket unavailable: ${String(err)}`);
  }
  const clis: McpCli[] = ["claude", "codex"];
  handle("mcp:state", fromServer, async () => Promise.all(clis.map((cli) => registrationOf(cli, currentMcpCommand(), runCli))));
  handle("mcp:register", fromServer, async (cli) => (cli === "claude" || cli === "codex" ? registerMcp(cli, currentMcpCommand(), runCli) : null));
}

function publicState(state: ConnectionState) {
  return { status: state.status, origin: state.origin, userId: state.userId, deviceId: state.deviceId, label: settings.label };
}

/**
 * `--defe2end-browser-check`: launch the browser the app would use for a PC run, print the outcome and quit.
 * For checking a package (no window, no server). Exit code 0 when the empty run passed.
 */
async function browserCheck(): Promise<void> {
  const executablePath = bundledBrowserPath();
  console.log(`[defe2end] packaged=${app.isPackaged} PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH ?? "(unset)"} executablePath=${executablePath ?? "(playwright default)"}`);
  let ok = true;
  // Both modes of contract 4.4.1: the visible window (default) and the "hide the browser" setting.
  for (const headless of [false, true]) {
    const verdict = await runPlan(
      { runId: "browser-check", baseUrl: "about:blank", steps: [], variables: {}, device: DEFAULT_DEVICE, stepTimeoutMs: 30_000, network: { blockPrivateNetworks: false }, capture: { video: false, traceOnFailure: false } },
      { sink: { open: async () => Promise.reject(new Error("no artifacts in a browser check")) }, onEvent: () => {}, signal: new AbortController().signal, owner: `desktop-check-${process.pid}`, sandbox: true, headless, ...(executablePath ? { executablePath } : {}) },
    );
    ok &&= verdict.status === "passed";
    console.log(`[defe2end] browser check (${headless ? "headless" : "visible"}): ${verdict.status}${verdict.browserVersion ? ` (${verdict.browserVersion})` : ""}${verdict.errorMessage ? ` — ${verdict.errorMessage}` : ""}`);
  }
  app.exit(ok ? 0 : 1);
}

if (process.argv.includes("--defe2end-browser-check")) {
  void app.whenReady().then(browserCheck);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  void app.whenReady().then(async () => {
    settings = await loadSettings();
    manager = new ConnectionManager(
      {
        fetchWithCookies: (url, init) => session.defaultSession.fetch(String(url), { ...init, credentials: "include" } as RequestInit),
        fetch: (url, init) => fetch(url, init),
        loadToken,
        saveToken,
        clearToken: async () => {
          await rm(tokenFile(), { force: true });
          await mcpHost?.clearToken();
        },
        webLogout: async (origin) => {
          await session.defaultSession.fetch(`${origin}/api/auth/sign-out`, { method: "POST", credentials: "include", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" } as RequestInit);
        },
        clearServerCookies: (origin) => session.defaultSession.clearStorageData({ origin, storages: ["cookies"] }),
        clearSideBrowser: async () => {
          sideBrowser?.close();
          testAttributes = [];
          await clearSideBrowserData();
        },
        onStreamMessage: (message) => {
          if (message.type === "capture-auth-state") {
            // Bound to the connection that asked: after a generation change it registers nowhere.
            const api = manager.api;
            if (api) captures.start(message, { register: (body) => registerAuthSession(api, body, (ms) => new Promise((r) => setTimeout(r, ms))), current: () => api.isCurrent() });
          }
          if (message.type === "connected") testAttributes = message.recorder.testAttributes;
        },
        stopCaptures: async () => captures.stop(),
        runPlan,
        onUpdateRequired: (body) => void showUpdateRequired(body),
        log,
      },
      { appVersion: app.getVersion(), runnerVersion: RUNNER_VERSION, installId: settings.installId, label: settings.label, dataDir: dataDir(), ownerMark: `desktop-${process.pid}`, sandbox: true, executablePath: bundledBrowserPath(), headless: () => settings.hideBrowser },
      settings.serverOrigin,
    );
    captures = new CaptureController({ open: openCaptureWindow, log });
    manager.onState((state) => send("connection:state", publicState(state)));
    manager.onRun((progress: RunProgress) => send("runs:progress", progress));
    denyPermissions(session.defaultSession);
    denyPermissions(session.fromPartition(SIDE_BROWSER_PARTITION));
    registerIpc();
    await startMcp();
    buildMenu();
    if (settings.serverOrigin) await loadAuthOrigins(settings.serverOrigin);
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Quit closes the window first, so the editor's unsaved-changes check runs (and can cancel the quit)
  // before anything is torn down; then it waits up to 5 s for runs to stop. A second quit doesn't wait.
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting || !manager) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      event.preventDefault();
      quitAfterClose = true;
      mainWindow.close();
      return;
    }
    quitting = true;
    event.preventDefault();
    // AI turns end with their process trees (SIGTERM, then SIGKILL) and temp files before the app goes.
    void Promise.all([manager.quit(5_000), mcpHost?.stop().catch(() => {}), chat?.stopAll().catch(() => {})]).finally(() => app.quit());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

// --- AI chat and failure diagnosis (stage 6 contract sections 7–8) ---------------------------------------------
// The web UI sees four calls: provider status, send (chat turn or one diagnosis turn), stop, events.

/** How chat starts `defe2end-mcp` (the same command the CLIs get registered with); null before the MCP host runs. */
const aiMcpServer = (): McpServerSpec | null => (mcpHost ? currentMcpCommand() : null);
let aiStatus: Promise<ProviderStatus[]> | null = null;
let aiPath: Promise<string> | null = null;
const providerStatus = (refresh = false) => {
  if (refresh || !aiStatus) {
    aiPath = userShellPath();
    aiStatus = aiPath.then((pathValue) => detectAll({ pathValue }));
  }
  return aiStatus;
};
let chat: ChatManager | null = null;
const chatManager = () =>
  (chat ??= new ChatManager({
    baseDir: path.join(dataDir(), "ai"),
    status: () => providerStatus(),
    mcpServer: () => aiMcpServer(),
    identity: () => {
      const st = manager.state;
      return `${st.origin}|${st.userId}|${st.deviceId}|${st.generation}`;
    },
    emit: (event) => send("ai:event", event),
    env: async () => ({ ...process.env, PATH: (await aiPath) ?? process.env.PATH ?? "" }),
  }));

function registerAiIpc(): void {
  // Paths stay in the main process; the page gets state and versions only.
  handle("ai:status", fromServer, async (refresh) =>
    (await providerStatus(refresh === true)).map((s) => (s.state === "ready" ? { provider: s.provider, state: s.state, version: s.version } : s.state === "unsupported" ? { provider: s.provider, state: s.state, version: s.version, minVersion: s.minVersion } : s)),
  );
  handle("ai:send", fromServer, (input) => {
    const i = input as { mode?: unknown; threadId?: unknown; provider?: unknown; text?: unknown; images?: unknown } | null;
    if (typeof i?.threadId !== "string" || i.threadId.length > 64 || typeof i.text !== "string") return { ok: false, reason: "invalid" };
    const provider = i.provider as "claude" | "codex";
    if (i.mode === "diagnosis") return chatManager().diagnose(i.threadId, provider, i.text);
    const images = Array.isArray(i.images) ? (i.images as { mediaType: string; base64: string }[]) : [];
    return chatManager().send({ threadId: i.threadId, provider, text: i.text, images });
  });
  handle("ai:stop", fromServer, (threadId) => (typeof threadId === "string" ? chatManager().stop(threadId) : false));
}
