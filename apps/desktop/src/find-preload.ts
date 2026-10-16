import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// Find bar (desktop spec 4): a local page that sends queries and hears match counts. Nothing else.
const on = (channel: string, listener: (payload: unknown) => void) => ipcRenderer.on(channel, (_event: IpcRendererEvent, payload: unknown) => listener(payload));

contextBridge.exposeInMainWorld("defe2endFind", {
  query: (text: string, forward: boolean, findNext: boolean) => ipcRenderer.send("find:query", { text, forward, findNext }),
  close: () => ipcRenderer.send("find:close"),
  onLabels: (listener: (labels: unknown) => void) => on("find:labels", listener),
  onResult: (listener: (label: unknown) => void) => on("find:result", listener),
  onFocus: (listener: () => void) => on("find:focus", () => listener()),
});
