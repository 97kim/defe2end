import { DIALOG_WRAPPER_SOURCE, installCollector, recorderDom, type RecorderState } from "@defe2end/recorder/dom";
import { ipcRenderer, webFrame } from "electron";

// Side browser tab preload (desktop spec 5.1–5.4). Sandboxed: no Node APIs, only `ipcRenderer`. Runs in every frame
// (`nodeIntegrationInSubFrames`); each frame sends its own raw events, and the main process owns ordering and ids.
// IPC: tab → main `recorder:event` (one raw event), main → tab `recorder:state`
// ({ recording, tabId, testAttributes, menuLabels }); every state is applied as it comes, including mid-recording.
const collector = installCollector({ dom: recorderDom(), send: (event) => ipcRenderer.send("recorder:event", event), testAttributes: [] });

ipcRenderer.on("recorder:state", (_event, state: RecorderState) => collector.setState(state));

// alert/confirm/prompt live in the page's world; wrap them there and hear the results back through postMessage.
void webFrame.executeJavaScript(DIALOG_WRAPPER_SOURCE);
window.addEventListener("message", (event) => {
  const data = (event.data as { __defe2endDialog?: { kind: "alert" | "confirm" | "prompt"; accepted: boolean; openMs?: number } } | null)?.__defe2endDialog;
  if (event.source === window && data) collector.dialog(data.kind, data.accepted, data.openMs);
});
