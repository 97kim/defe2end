// The app has one side browser; the web UI decides where it is drawn. The editor's recorder panel owns it
// while open; otherwise the workspace-level panel does, so an AI request to open it is answered on any page.

export type SideBrowserOwner = "recorder" | "workspace";

let recorderOpen = false;
const listeners = new Set<() => void>();

/** Who draws the side browser right now. */
export function sideBrowserOwner(): SideBrowserOwner {
  return recorderOpen ? "recorder" : "workspace";
}

/** The recorder panel takes the side browser while it is open; returns the release. */
export function claimForRecorder(): () => void {
  recorderOpen = true;
  listeners.forEach((l) => l());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    recorderOpen = false;
    listeners.forEach((l) => l());
  };
}

export function subscribeSideBrowserOwner(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
