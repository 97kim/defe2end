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

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The parts of the app's preload API the workspace column uses. */
export interface ColumnBridge {
  sideBrowser: { open(url: string | undefined, bounds: Bounds): Promise<unknown>; setBounds(bounds: Bounds): Promise<unknown>; close(): Promise<unknown> };
  mcp?: { onOpenRequested?(listener: () => void): () => void };
}

/**
 * Keeps the app's browser over the workspace column: opens it now and again on every AI open request (the user
 * may have closed its last tab while the column stayed; opening an open browser only sets its bounds), sends
 * the bounds whenever `watch` says the area may have moved, and closes it with the column unless the recorder
 * panel took it over. Returns the teardown.
 */
export function wireColumn({ bridge, bounds, watch, onError }: { bridge: ColumnBridge; bounds: () => Bounds | null; watch: (sync: () => void) => () => void; onError: () => void }): () => void {
  const open = () => {
    const b = bounds();
    if (b) void bridge.sideBrowser.open(undefined, b).catch(onError);
  };
  const sync = () => {
    const b = bounds();
    if (b) void bridge.sideBrowser.setBounds(b);
  };
  open();
  const offOpen = bridge.mcp?.onOpenRequested?.(() => {
    if (sideBrowserOwner() === "workspace") open();
  });
  const unwatch = watch(sync);
  return () => {
    offOpen?.();
    unwatch();
    // Handed to the recorder panel: it already drew the browser over its own area.
    if (sideBrowserOwner() === "workspace") void bridge.sideBrowser.close().catch(() => {});
  };
}
