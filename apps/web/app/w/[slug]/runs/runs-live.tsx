"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Alert, Button, Dialog } from "../../../../components/ui";
import { StopIcon } from "./run-ui";

/** Lists re-read every 3 s while one of their runs is queued or running (single runs stream over SSE instead). */
export function RefreshWhileActive({ everyMs = 3_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return null;
}

/** Admin: cancel every run that is queued or running right now (later requests are not blocked). */
export function StopAllButton({ slug, available }: { slug: string; available: boolean }) {
  const t = useTranslations("runs.stopAll");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  return (
    <>
      {done && <span role="status" className="text-meta text-text-secondary">{done}</span>}
      <Button variant="secondary" disabled={!available} title={available ? undefined : t("coming")} onClick={() => setOpen(true)}>
        <StopIcon />
        {t("button")}
      </Button>
      {open && (
        <Dialog
          title={t("title")}
          onClose={() => !busy && setOpen(false)}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
                {t("keep")}
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(undefined);
                  const res = await fetch(`/api/w/${slug}/runs/stop-all`, { method: "POST" });
                  const body = await res.json().catch(() => undefined);
                  setBusy(false);
                  if (!res.ok) return setError(body?.error?.message ?? t("failed"));
                  setOpen(false);
                  setDone(t("done", { cancelled: body.cancelled ?? 0, requested: body.cancelRequested ?? 0 }));
                  router.refresh();
                }}
              >
                {t("confirm")}
              </Button>
            </>
          }
        >
          <p className="text-text-secondary">{t("body")}</p>
          {error && <Alert>{error}</Alert>}
        </Dialog>
      )}
    </>
  );
}
