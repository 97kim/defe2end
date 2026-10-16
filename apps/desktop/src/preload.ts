import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// Sandboxed preload, bundled to one file: only `ipcRenderer`, nothing from Node. The main process checks
// every call's sender (server origin, or the bundled setup page for `setup`), so exposing the full list here
// gives a foreign page nothing.

function subscribe(channel: string, listener: (payload: unknown) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => void ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("defe2end", {
  version: ipcRenderer.sendSync("app:version") as string,
  setup: {
    check: (url: string) => ipcRenderer.invoke("setup:check", url),
    save: (url: string) => ipcRenderer.invoke("setup:save", url),
    cancel: () => ipcRenderer.invoke("setup:cancel"),
  },
  connection: {
    state: () => ipcRenderer.invoke("connection:state"),
    onState: (listener: (state: unknown) => void) => subscribe("connection:state", listener),
    connect: () => ipcRenderer.invoke("connection:connect"),
    disconnect: () => ipcRenderer.invoke("connection:disconnect"),
    logout: () => ipcRenderer.invoke("connection:logout"),
    setAlias: (alias: string) => ipcRenderer.invoke("connection:setAlias", alias),
  },
  update: {
    state: () => ipcRenderer.invoke("update:state"),
    onAvailable: (listener: (update: unknown) => void) => subscribe("app:update", listener),
    open: () => ipcRenderer.invoke("update:open"),
    getEnabled: () => ipcRenderer.invoke("update:getEnabled"),
    setEnabled: (value: boolean) => ipcRenderer.invoke("update:setEnabled", value),
  },
  runs: {
    onProgress: (listener: (progress: unknown) => void) => subscribe("runs:progress", listener),
  },
  sideBrowser: {
    open: (url: string | undefined, bounds: unknown) => ipcRenderer.invoke("sideBrowser:open", url, bounds),
    close: () => ipcRenderer.invoke("sideBrowser:close"),
    hide: () => ipcRenderer.invoke("sideBrowser:hide"),
    setBounds: (bounds: unknown) => ipcRenderer.invoke("sideBrowser:setBounds", bounds),
    navigate: (url: string) => ipcRenderer.invoke("sideBrowser:navigate", url),
    selectTab: (id: string) => ipcRenderer.invoke("sideBrowser:selectTab", id),
    closeTab: (id: string) => ipcRenderer.invoke("sideBrowser:closeTab", id),
    clearData: () => ipcRenderer.invoke("sideBrowser:clearData"),
    setDragging: (dragging: boolean) => ipcRenderer.invoke("sideBrowser:setDragging", dragging),
    setDevice: (device: "desktop" | "mobile") => ipcRenderer.invoke("sideBrowser:setDevice", device),
    openDevTools: () => ipcRenderer.invoke("sideBrowser:openDevTools"),
    saveSession: (target: { workspaceId: string; environmentId: string }) => ipcRenderer.invoke("sideBrowser:saveSession", target),
    onTabs: (listener: (tabs: unknown) => void) => subscribe("sideBrowser:tabs", listener),
  },
  recorder: {
    start: () => ipcRenderer.invoke("recorder:start"),
    stop: () => ipcRenderer.invoke("recorder:stop"),
    discard: (eventIds: string[]) => ipcRenderer.invoke("recorder:discard", eventIds),
    onResult: (listener: (result: unknown) => void) => subscribe("recorder:result", listener),
    onCheckRequested: (listener: (request: unknown) => void) => subscribe("recorder:checkRequested", listener),
  },
  ai: {
    status: (refresh?: boolean) => ipcRenderer.invoke("ai:status", refresh === true),
    send: (input: unknown) => ipcRenderer.invoke("ai:send", input),
    stop: (threadId: string) => ipcRenderer.invoke("ai:stop", threadId),
    onEvent: (listener: (event: unknown) => void) => subscribe("ai:event", listener),
  },
  // Stage 6: "AI connection" settings and the side browser's AI sign.
  mcp: {
    state: () => ipcRenderer.invoke("mcp:state"),
    register: (cli: "claude" | "codex") => ipcRenderer.invoke("mcp:register", cli),
    onOpenRequested: (listener: () => void) => subscribe("sideBrowser:openRequested", () => listener()),
    onAiActive: (listener: (active: boolean) => void) => subscribe("sideBrowser:aiActive", (active) => listener(active === true)),
  },
  app: {
    changeServer: () => ipcRenderer.invoke("app:changeServer"),
    getHideBrowser: () => ipcRenderer.invoke("app:getHideBrowser") as Promise<boolean>,
    setHideBrowser: (hide: boolean) => ipcRenderer.invoke("app:setHideBrowser", hide) as Promise<boolean>,
  },
});
