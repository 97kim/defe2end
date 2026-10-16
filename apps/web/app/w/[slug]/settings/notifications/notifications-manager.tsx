"use client";

import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import { Alert, Button, Chip, Dialog, EmptyState, Field, Input, Toasts, Toggle, useToasts } from "../../../../../components/ui";
import type { DeliveryView, WebhookView } from "../../../../../lib/notifications";
import { useHydrated } from "../../runs/use-hydrated";

const NOTIFY_ON = ["failures", "all", "changes"] as const;
const SOURCES = ["schedule", "api", "manual"] as const;

type Draft = Omit<WebhookView, "id" | "urlHint" | "invalidAt" | "createdAt"> & { url: string };

const blank = (timezone: string): Draft => ({ name: "", url: "", notifyOn: "failures", sources: ["schedule", "api"], dailyReport: false, reportTime: "09:00", reportTimezone: timezone });

export function NotificationsManager({ slug, webhooks, canWrite, defaultTimezone }: { slug: string; webhooks: WebhookView[]; canWrite: boolean; defaultTimezone: string }) {
  const t = useTranslations("settings.notifications");
  const format = useFormatter();
  const hydrated = useHydrated();
  const router = useRouter();
  const { toasts, push, dismiss } = useToasts();
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft; urlHint?: string } | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [deleting, setDeleting] = useState<WebhookView | null>(null);
  const [history, setHistory] = useState<{ hook: WebhookView; rows: DeliveryView[] | null } | null>(null);
  const when = (iso: string) => (hydrated ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "medium" }) : "");
  const base = `/api/w/${slug}/notifications/webhooks`;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy("save");
    setError(undefined);
    const { url, ...rest } = editing.draft;
    const body = editing.id ? { ...rest, url } : { ...rest, url };
    const res = await fetch(editing.id ? `${base}/${editing.id}` : base, { method: editing.id ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(undefined);
    if (!res.ok) return setError((await res.json().catch(() => undefined))?.error?.message ?? t("errorGeneric"));
    setEditing(null);
    router.refresh();
  }

  async function patch(hook: WebhookView, body: object) {
    setBusy(hook.id);
    const res = await fetch(`${base}/${hook.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(undefined);
    if (!res.ok) return push(t("errorGeneric"), "error");
    router.refresh();
  }

  async function test(hook: WebhookView) {
    setBusy(hook.id);
    const res = await fetch(`${base}/${hook.id}/test`, { method: "POST" });
    setBusy(undefined);
    const body = await res.json().catch(() => undefined);
    if (!res.ok) return push(body?.error?.message ?? t("errorGeneric"), "error");
    if (body.status === "sent") push(t("testSent"));
    else {
      const code = String(body.statusCode ?? body.errorCode ?? "-");
      push(body.status === "dead" ? t("testRejected", { code }) : t("testFailed", { code }), "error");
    }
    router.refresh();
  }

  async function remove() {
    if (!deleting) return;
    setBusy(deleting.id);
    const res = await fetch(`${base}/${deleting.id}`, { method: "DELETE" });
    setBusy(undefined);
    setDeleting(null);
    if (!res.ok) return push(t("errorGeneric"), "error");
    router.refresh();
  }

  async function openHistory(hook: WebhookView) {
    setHistory({ hook, rows: null });
    const res = await fetch(`${base}/${hook.id}/deliveries`);
    const body = res.ok ? await res.json() : { deliveries: [] };
    setHistory({ hook, rows: body.deliveries });
  }

  const set = (patch: Partial<Draft>) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-[640px] text-text-secondary">{t("intro")}</p>
        {canWrite && (
          <Button onClick={() => (setError(undefined), setEditing({ id: null, draft: blank(defaultTimezone) }))}>{t("add")}</Button>
        )}
      </div>
      {webhooks.length === 0 ? (
        <EmptyState title={t("empty")} body={t("emptyBody")} />
      ) : (
        <section className="overflow-x-auto rounded-card border border-border bg-bg-surface shadow-e1">
          <table className="w-full text-left text-body">
            <thead className="border-b border-border bg-bg-subtle text-meta text-text-secondary">
              <tr>
                <th className="px-4 py-2 font-semibold">{t("name")}</th>
                <th className="px-4 py-2 font-semibold">{t("notifyOn")}</th>
                <th className="px-4 py-2 font-semibold">{t("sources")}</th>
                <th className="px-4 py-2 font-semibold">{t("dailyReport")}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {webhooks.map((hook) => (
                <tr key={hook.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-3">
                    <span className="font-semibold">{hook.name}</span>
                    <span className="block font-mono text-code text-text-muted">…{hook.urlHint}</span>
                    {hook.invalidAt && <span className="block text-meta font-semibold text-fail">{t("invalid", { when: when(hook.invalidAt) })}</span>}
                  </td>
                  <td className="px-4 py-3">{t(`notifyOnValues.${hook.notifyOn}`)}</td>
                  <td className="px-4 py-3 text-text-secondary">{hook.sources.map((s) => t(`sourceValues.${s}`)).join(", ") || "—"}</td>
                  <td className="px-4 py-3 font-mono text-code text-text-secondary">{hook.dailyReport ? `${hook.reportTime} ${hook.reportTimezone}` : "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" onClick={() => void openHistory(hook)}>
                        {t("history")}
                      </Button>
                      {canWrite && (
                        <>
                          {hook.invalidAt && (
                            <Button variant="secondary" disabled={busy === hook.id} onClick={() => void patch(hook, { invalid: false })}>
                              {t("reenable")}
                            </Button>
                          )}
                          <Button variant="secondary" disabled={busy === hook.id} onClick={() => void test(hook)}>
                            {t("test")}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setError(undefined);
                              const { id, urlHint, invalidAt: _i, createdAt: _c, ...rest } = hook;
                              setEditing({ id, urlHint, draft: { ...rest, url: "" } });
                            }}
                          >
                            {t("edit")}
                          </Button>
                          <Button variant="ghost" onClick={() => setDeleting(hook)}>
                            {t("delete")}
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {editing && (
        <Dialog
          title={editing.id ? t("editTitle") : t("addTitle")}
          onClose={() => busy !== "save" && setEditing(null)}
          onSubmit={(e) => void save(e)}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={busy === "save"}>
                {t("save")}
              </Button>
            </>
          }
        >
          {error && <Alert>{error}</Alert>}
          <Field label={t("name")}>
            <Input autoFocus required value={editing.draft.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label={t("url")} hint={editing.id ? t("urlKeep", { hint: editing.urlHint ?? "" }) : t("urlHint")}>
            <Input type="url" required={!editing.id} autoComplete="off" value={editing.draft.url} placeholder="https://hooks.slack.com/services/…" onChange={(e) => set({ url: e.target.value })} />
          </Field>
          <Field label={t("notifyOn")} hint={t(`notifyOnHints.${editing.draft.notifyOn}`)}>
            <div className="flex gap-2">
              {NOTIFY_ON.map((v) => (
                <Chip key={v} active={editing.draft.notifyOn === v} onClick={() => set({ notifyOn: v })}>
                  {t(`notifyOnValues.${v}`)}
                </Chip>
              ))}
            </div>
          </Field>
          <Field label={t("sources")}>
            <div className="flex gap-2">
              {SOURCES.map((s) => (
                <Chip
                  key={s}
                  active={editing.draft.sources.includes(s)}
                  onClick={() => set({ sources: editing.draft.sources.includes(s) ? editing.draft.sources.filter((x) => x !== s) : [...editing.draft.sources, s] })}
                >
                  {t(`sourceValues.${s}`)}
                </Chip>
              ))}
            </div>
          </Field>
          <Toggle checked={editing.draft.dailyReport} onChange={(dailyReport) => set({ dailyReport })} label={t("dailyReportToggle")} />
          {editing.draft.dailyReport && (
            <div className="flex gap-3">
              <Field label={t("reportTime")}>
                <Input type="time" required value={editing.draft.reportTime} onChange={(e) => set({ reportTime: e.target.value })} />
              </Field>
              <Field label={t("reportTimezone")} hint={t("reportTimezoneHint")}>
                <Input required value={editing.draft.reportTimezone} onChange={(e) => set({ reportTimezone: e.target.value })} />
              </Field>
            </div>
          )}
        </Dialog>
      )}

      {deleting && (
        <Dialog
          title={t("deleteTitle", { name: deleting.name })}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeleting(null)}>
                {t("cancel")}
              </Button>
              <Button variant="danger" disabled={busy === deleting.id} onClick={() => void remove()}>
                {t("delete")}
              </Button>
            </>
          }
        >
          <p className="text-text-secondary">{t("deleteBody")}</p>
        </Dialog>
      )}

      {history && (
        <Dialog wide title={t("historyTitle", { name: history.hook.name })} onClose={() => setHistory(null)}>
          {history.rows === null ? (
            <p className="text-text-muted">{t("loading")}</p>
          ) : history.rows.length === 0 ? (
            <p className="text-text-muted">{t("historyEmpty")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {history.rows.map((d) => (
                <li key={d.id} className="py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span>
                      <span className="font-semibold">{t(`kindValues.${d.kind}`)}</span> <span className={d.status === "sent" ? "text-pass" : d.status === "pending" || d.status === "sending" ? "text-text-secondary" : "text-fail"}>{t(`statusValues.${d.status}`)}</span>
                    </span>
                    <span className="font-mono text-code text-text-muted">{when(d.createdAt)}</span>
                  </div>
                  <ol className="mt-1 flex flex-col gap-0.5 font-mono text-code text-text-secondary">
                    {d.attemptRows.map((a) => (
                      <li key={a.attempt}>
                        #{a.attempt} {when(a.startedAt)} · {a.statusCode ?? "—"} {a.errorCode ? `(${a.errorCode})` : ""} {a.durationMs !== null ? `${a.durationMs}ms` : t("noResult")}
                      </li>
                    ))}
                  </ol>
                  {d.nextAttemptAt && <p className="text-meta text-text-muted">{t("nextAttempt", { when: when(d.nextAttemptAt) })}</p>}
                </li>
              ))}
            </ul>
          )}
        </Dialog>
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
