import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// Recording card (desktop spec 5.1): a local page that only receives the step count and the last step.
contextBridge.exposeInMainWorld("defe2endHud", {
  onUpdate: (listener: (update: unknown) => void) => ipcRenderer.on("hud:update", (_event: IpcRendererEvent, update: unknown) => listener(update)),
});
