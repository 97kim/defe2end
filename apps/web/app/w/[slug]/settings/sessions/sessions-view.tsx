"use client";

import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Dialog, EmptyState, Toasts, useToasts } from "../../../../../components/ui";
import { useHydrated } from "../../runs/use-hydrated";

export interface SessionRow {
  environmentId: string;
  environmentName: string;
  siteName: string;
  baseUrl: string;
  session: { id: string; cookieCount: number; savedAt: string; expiresAt: string } | null;
}

export function AuthSessionsView({ slug, rows, canWrite }: { slug: string; rows: SessionRow[]; canWrite: boolean }) {
  const t = useTranslations("settings.authSessions");
  const format = useFormatter();
  const hydrated = useHydrated();
  const router = useRouter();
  const { toasts, push, dismiss } = useToasts();
  const [busy, setBusy] = useState<string>();
  const [deleting, setDeleting] = useState<SessionRow | null>(null);
  const when = (iso: string) => (hydrated ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : "");

  async function capture(row: SessionRow) {
    setBusy(row.environmentId);
    const res = await fetch(`/api/w/${slug}/environments/${row.environmentId}/auth-session/capture`, { method: "POST" });
    const body = res.ok ? undefined : await res.json().catch(() => undefined);
    setBusy(undefined);
    if (res.ok) return push(t("captureSent"));
    const code = body?.error?.code;
    push(code === "desktop_not_connected" ? t("errorDesktop") : code === "app_update_required" ? t("errorUpdate") : (body?.error?.message ?? t("errorGeneric")), "error");
  }

  async function remove() {
    if (!deleting?.session) return;
    setBusy(deleting.environmentId);
    const res = await fetch(`/api/w/${slug}/auth-sessions/${deleting.session.id}`, { method: "DELETE" });
    setBusy(undefined);
    setDeleting(null);
    if (!res.ok) return push(t("errorGeneric"), "error");
    router.refresh();
  }

  if (rows.length === 0) return <EmptyState title={t("empty")} />;

  return (
    <div className="flex max-w-[960px] flex-col gap-4">
      <p className="max-w-[640px] text-text-secondary">{t("intro")}</p>
      {!canWrite && <p className="text-meta text-text-muted">{t("viewerHint")}</p>}
      <section className="overflow-x-auto rounded-card border border-border bg-bg-surface shadow-e1">
        <table className="w-full text-left text-body">
          <thead className="border-b border-border bg-bg-subtle text-meta text-text-secondary">
            <tr>
              <th className="px-4 py-2 font-semibold">{t("environment")}</th>
              <th className="px-4 py-2 font-semibold">{t("status")}</th>
              <th className="px-4 py-2 font-semibold">{t("savedAt")}</th>
              <th className="px-4 py-2 font-semibold">{t("expiresAt")}</th>
              <th className="px-4 py-2 text-right font-semibold">{t("cookies")}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const s = row.session;
              const expired = s !== null && hydrated && new Date(s.expiresAt).getTime() <= Date.now();
              const state = s === null ? "missing" : expired ? "expired" : "valid";
              const tone = state === "valid" ? "text-pass" : state === "expired" ? "text-warn" : "text-text-muted";
              return (
                <tr key={row.environmentId} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-3">
                    <span className="font-semibold">{row.siteName}</span> <span className="text-text-secondary">/ {row.environmentName}</span>
                    <span className="block truncate font-mono text-code text-text-muted">{row.baseUrl}</span>
                  </td>
                  <td className={`px-4 py-3 font-semibold ${tone}`}>{t(state)}</td>
                  <td className="px-4 py-3 font-mono text-code text-text-secondary">{s ? when(s.savedAt) : "—"}</td>
                  <td className="px-4 py-3 font-mono text-code text-text-secondary">{s ? when(s.expiresAt) : "—"}</td>
                  <td className="px-4 py-3 text-right font-mono text-code">{s ? s.cookieCount : "—"}</td>
                  <td className="px-4 py-3">
                    {canWrite && (
                      <span className="flex justify-end gap-2">
                        <Button variant="secondary" disabled={busy !== undefined} onClick={() => void capture(row)}>
                          {s ? t("recreate") : t("create")}
                        </Button>
                        {s && (
                          <Button variant="secondary" disabled={busy !== undefined} onClick={() => setDeleting(row)}>
                            {t("delete")}
                          </Button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      {deleting && (
        <Dialog
          title={t("deleteTitle")}
          onClose={() => busy === undefined && setDeleting(null)}
          footer={
            <>
              <Button variant="secondary" disabled={busy !== undefined} onClick={() => setDeleting(null)}>
                {t("keep")}
              </Button>
              <Button variant="danger" disabled={busy !== undefined} onClick={() => void remove()}>
                {t("delete")}
              </Button>
            </>
          }
        >
          <p className="text-text-secondary">{t("deleteBody", { environment: `${deleting.siteName} / ${deleting.environmentName}` })}</p>
        </Dialog>
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
