"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "../ui";

/** `window.defe2end.update` of the desktop app (stage 8 contract section 1); absent in a plain browser. */
interface UpdateBridge {
  state(): Promise<{ version: string } | null>;
  onAvailable(listener: (update: unknown) => void): () => void;
  open(): Promise<unknown>;
  setEnabled(value: boolean): Promise<boolean>;
}

export function updateBridge(win: unknown): UpdateBridge | null {
  const u = (win as { defe2end?: { update?: Partial<UpdateBridge> } } | undefined)?.defe2end?.update;
  if (!u || !["state", "onAvailable", "open", "setEnabled"].every((n) => typeof (u as Record<string, unknown>)[n] === "function")) return null;
  return u as UpdateBridge;
}

const versionOf = (update: unknown) => (update && typeof (update as { version?: unknown }).version === "string" ? (update as { version: string }).version : null);

/** A newer desktop release, with the download page and a way to stop checking. Renders nothing outside the app. */
export function UpdateNotice() {
  const t = useTranslations("settings.desktopApp");
  const [bridge, setBridge] = useState<UpdateBridge | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    const b = updateBridge(window);
    setBridge(b);
    if (!b) return;
    void b.state().then((u) => setVersion(versionOf(u)), () => undefined);
    return b.onAvailable((u) => setVersion(versionOf(u)));
  }, []);

  if (!bridge || !version || dismissed === version) return null;
  return (
    <div role="status" className="fixed bottom-4 left-4 z-30 flex max-w-sm flex-col gap-2 rounded-lg border border-border-strong bg-bg-surface p-3 text-meta text-text-primary shadow-e2">
      <p>{t("updateAvailable", { version })}</p>
      <div className="flex gap-2">
        <Button type="button" onClick={() => void bridge.open()}>
          {t("updateDownload")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setDismissed(version);
            void bridge.setEnabled(false);
          }}
        >
          {t("updateTurnOff")}
        </Button>
      </div>
    </div>
  );
}
