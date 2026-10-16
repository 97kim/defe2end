"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Button } from "../../../components/ui";
import { useDesktopBridge, type DesktopBridge } from "./scenarios/recorder-panel";
import { sideBrowserOwner, subscribeSideBrowserOwner } from "./side-browser-owner";

// The side browser outside the editor (stage 6 contract section 5): when an AI browser tool asks for it and the
// recorder panel isn't open, this column opens between the page and the chat panel, and the app draws the
// browser over its area. It starts blank; the AI's `browser_navigate` takes it somewhere.

const COLUMN_WIDTH = 480;

export function SideBrowserPanel() {
  const bridge = useDesktopBridge();
  const owner = useSyncExternalStore(subscribeSideBrowserOwner, sideBrowserOwner, () => "workspace" as const);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    return bridge.mcp?.onOpenRequested?.(() => {
      if (sideBrowserOwner() === "workspace") setOpen(true);
    });
  }, [bridge]);

  // The recorder took the browser over (its close also closes the browser), so this column is done.
  useEffect(() => {
    if (owner === "recorder") setOpen(false);
  }, [owner]);

  if (!bridge || !open || owner !== "workspace") return null;
  return <Column bridge={bridge} onClose={() => setOpen(false)} />;
}

function Column({ bridge, onClose }: { bridge: DesktopBridge; onClose: () => void }) {
  const t = useTranslations("ai.sideBrowser");
  const [aiActive, setAiActive] = useState(false);
  const [error, setError] = useState<string>();
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bounds = () => {
      const r = slot.current?.getBoundingClientRect();
      return r ? { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.max(0, r.width), height: Math.max(0, r.height) } : null;
    };
    const b = bounds();
    if (b) void bridge.sideBrowser.open(undefined, b).catch(() => setError(t("error")));
    const sync = () => {
      const next = bounds();
      if (next) void bridge.sideBrowser.setBounds(next);
    };
    // The column keeps its width, but moves when the chat panel or the page beside it changes size.
    const observer = new ResizeObserver(sync);
    if (slot.current) observer.observe(slot.current);
    const main = document.querySelector("main");
    if (main) observer.observe(main);
    window.addEventListener("resize", sync);
    const offAi = bridge.mcp?.onAiActive?.(setAiActive);
    return () => {
      offAi?.();
      observer.disconnect();
      window.removeEventListener("resize", sync);
      // Handed to the recorder panel: it already drew the browser over its own area.
      if (sideBrowserOwner() === "workspace") void bridge.sideBrowser.close().catch(() => {});
    };
    // Opened once per column.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  return (
    <section aria-label={t("title")} style={{ width: COLUMN_WIDTH }} className="t-panel-slide sticky top-0 flex h-screen shrink-0 flex-col border-l border-border bg-bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="flex-1 text-title-sm text-text-primary">{t("title")}</h2>
        {aiActive && (
          <span role="status" className="flex items-center gap-1.5 rounded-full bg-bg px-2 py-0.5 text-meta font-semibold">
            <span aria-hidden="true" className="size-2 rounded-full bg-accent motion-safe:animate-pulse" />
            {t("aiActive")}
          </span>
        )}
        <Button variant="secondary" onClick={onClose} aria-label={t("closeLabel")}>
          {t("close")}
        </Button>
      </header>
      {error && (
        <div className="px-4 py-2">
          <Alert>{error}</Alert>
        </div>
      )}
      {/* The app draws the side browser over this area. */}
      <div ref={slot} className="flex min-h-0 flex-1 items-center justify-center bg-bg-subtle text-meta text-text-muted">
        {t("area")}
      </div>
      {/* Below the browser, so the chat's floating button (bottom right) isn't covered by the native view. */}
      <p className="flex h-16 shrink-0 items-center border-t border-border px-4 pr-40 text-meta text-text-muted">{t("hint")}</p>
    </section>
  );
}
