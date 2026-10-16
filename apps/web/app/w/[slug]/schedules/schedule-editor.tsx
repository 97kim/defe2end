"use client";

import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Chip, Dialog, Field, Input, inputClass, Toasts, Toggle, useToasts } from "../../../../components/ui";
import { api } from "../../../../lib/api-client";
import type { ScheduleView } from "../../../../lib/schedules";
import { useHydrated } from "../runs/use-hydrated";
import type { EditorOptions } from "./editor-data";
import { CronLabel } from "./schedule-ui";

export interface ScheduleValues {
  variables: { id: string; key: string; isSecret: boolean; hasValue: boolean; value?: string }[];
  authSession: { required: boolean; savedAt: string | null; expiresAt: string | null; expired: boolean };
}

type Preview = { ok: true; times: string[] } | { ok: false; code: string; message: string };

export function ScheduleEditor({ slug, options, defaultTimezone, schedule, values, canWrite }: { slug: string; options: EditorOptions; defaultTimezone: string; schedule?: ScheduleView; values?: ScheduleValues; canWrite: boolean }) {
  const t = useTranslations("schedules");
  const router = useRouter();
  const { toasts, push, dismiss } = useToasts();
  const [name, setName] = useState(schedule?.name ?? "");
  const [environmentId, setEnvironmentId] = useState(schedule?.environmentId ?? options.environments[0]?.id ?? "");
  const [byTag, setByTag] = useState(Boolean(schedule?.tagId));
  const [scenarioIds, setScenarioIds] = useState<string[]>(schedule?.scenarioIds ?? []);
  const [tagId, setTagId] = useState(schedule?.tagId ?? options.tags[0]?.id ?? "");
  const [mode, setMode] = useState(schedule?.mode ?? "sequential");
  const [continueOnFailure, setContinueOnFailure] = useState(schedule?.continueOnFailure ?? true);
  const [cron, setCron] = useState(schedule?.cron ?? "0 2 * * *");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? defaultTimezone);
  const [overlap, setOverlap] = useState(schedule?.overlap ?? "skip");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const environment = options.environments.find((e) => e.id === environmentId);
  const siteScenarios = useMemo(() => options.scenarios.filter((s) => s.siteId === environment?.siteId), [options.scenarios, environment?.siteId]);
  const timezones = useMemo(() => (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []), []);

  // Preview as the expression or time zone changes (debounced).
  useEffect(() => {
    const timer = setTimeout(async () => {
      const res = await api<Preview>(`/api/w/${slug}/schedules/preview?${new URLSearchParams({ cron, timezone })}`);
      if (res.data) setPreview(res.data);
    }, 300);
    return () => clearTimeout(timer);
  }, [slug, cron, timezone]);

  const body = (extra: Record<string, unknown> = {}) => ({
    name,
    environmentId,
    ...(byTag ? { scenarioIds: [], tagId } : { scenarioIds: scenarioIds.filter((id) => siteScenarios.some((s) => s.id === id)), tagId: null }),
    mode,
    continueOnFailure,
    cron,
    timezone,
    overlap,
    enabled,
    ...extra,
  });

  async function save(extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(undefined);
    const res = schedule ? await api<ScheduleView>(`/api/w/${slug}/schedules/${schedule.id}`, "PATCH", body(extra)) : await api<ScheduleView>(`/api/w/${slug}/schedules`, "POST", body());
    setBusy(false);
    if (!res.ok) {
      const err = res.error as { code: string; message: string; reason?: string; values?: number } | undefined;
      if (err?.reason === "values_reset_required") return setConfirmReset(err.values ?? 0);
      return setError(err?.message ?? t("edit.errorGeneric"));
    }
    setConfirmReset(null);
    push(t("edit.saved"));
    if (!schedule) router.push(`/w/${slug}/schedules/${res.data!.id}`);
    else router.refresh();
  }

  async function remove() {
    if (!schedule) return;
    setBusy(true);
    const res = await api(`/api/w/${slug}/schedules/${schedule.id}`, "DELETE");
    setBusy(false);
    if (!res.ok) return setError(res.error?.message ?? t("edit.errorGeneric"));
    router.push(`/w/${slug}/schedules`);
  }

  const toggleScenario = (id: string) => setScenarioIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  return (
    <div className="flex max-w-[960px] flex-col gap-8">
      <section className="flex flex-col gap-4 rounded-card border border-border bg-bg-surface p-6 shadow-e1">
        {error && <Alert>{error}</Alert>}
        <Field label={t("edit.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} maxLength={100} />
        </Field>
        <Field label={t("edit.environment")}>
          <select className={inputClass} value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} disabled={!canWrite}>
            {options.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.siteName} / {e.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("edit.targetKind")}>
          <div className="flex gap-2">
            <Chip active={!byTag} disabled={!canWrite} onClick={() => setByTag(false)}>
              {t("edit.targetScenarios")}
            </Chip>
            <Chip active={byTag} disabled={!canWrite || options.tags.length === 0} onClick={() => setByTag(true)}>
              {t("edit.targetTag")}
            </Chip>
          </div>
        </Field>
        {byTag ? (
          <Field label={t("edit.tag")} hint={t("edit.tagHint")}>
            <select className={inputClass} value={tagId} onChange={(e) => setTagId(e.target.value)} disabled={!canWrite}>
              {options.tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label={t("edit.targetScenarios")} hint={t("edit.scenariosHint")}>
            <div className="flex flex-wrap gap-2">
              {siteScenarios.map((s) => {
                const index = scenarioIds.indexOf(s.id);
                return (
                  <Chip key={s.id} active={index >= 0} disabled={!canWrite} onClick={() => toggleScenario(s.id)}>
                    {index >= 0 ? `${index + 1}. ` : ""}
                    {s.name}
                  </Chip>
                );
              })}
            </div>
          </Field>
        )}
        <div className="flex flex-wrap gap-6">
          <Field label={t("edit.mode")}>
            <div className="flex gap-2">
              <Chip active={mode === "sequential"} disabled={!canWrite} onClick={() => setMode("sequential")}>
                {t("edit.sequential")}
              </Chip>
              <Chip active={mode === "parallel"} disabled={!canWrite} onClick={() => setMode("parallel")}>
                {t("edit.parallel")}
              </Chip>
            </div>
          </Field>
          <Toggle checked={continueOnFailure} onChange={setContinueOnFailure} label={t("edit.continueOnFailure")} disabled={!canWrite} />
        </div>
        <div className="flex flex-wrap gap-6">
          <div className="min-w-[260px] flex-1">
            <Field label={t("edit.cron")} hint={t("edit.cronHint")} error={preview && !preview.ok ? preview.message : undefined}>
              <Input className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} disabled={!canWrite} />
            </Field>
          </div>
          <div className="min-w-[220px]">
            <Field label={t("edit.timezone")}>
              <Input list="schedule-timezones" value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!canWrite} />
            </Field>
            <datalist id="schedule-timezones">
              {timezones.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </div>
        </div>
        {preview?.ok && <CronPreview cron={cron} times={preview.times} timezone={timezone} />}
        <Field label={t("edit.overlap")}>
          <div className="flex gap-2">
            <Chip active={overlap === "skip"} disabled={!canWrite} onClick={() => setOverlap("skip")}>
              {t("edit.overlapSkip")}
            </Chip>
            <Chip active={overlap === "allow"} disabled={!canWrite} onClick={() => setOverlap("allow")}>
              {t("edit.overlapAllow")}
            </Chip>
          </div>
        </Field>
        <Toggle checked={enabled} onChange={setEnabled} label={t("edit.enabled")} disabled={!canWrite} />
        {canWrite && (
          <div className="flex justify-between gap-2 border-t border-border pt-4">
            <Button disabled={busy || !name.trim()} onClick={() => void save()}>
              {t("edit.save")}
            </Button>
            {schedule && (
              <Button variant="danger" disabled={busy} onClick={() => setDeleting(true)}>
                {t("edit.delete")}
              </Button>
            )}
          </div>
        )}
      </section>

      {schedule && values ? <ScheduleValuesPanel slug={slug} scheduleId={schedule.id} environmentId={schedule.environmentId} values={values} canWrite={canWrite} onMessage={push} /> : <p className="text-meta text-text-muted">{t("values.saveFirst")}</p>}

      {confirmReset !== null && (
        <Dialog
          title={t("edit.resetTitle")}
          onClose={() => !busy && setConfirmReset(null)}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirmReset(null)}>
                {t("edit.cancel")}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void save({ confirmValueReset: true })}>
                {t("edit.resetConfirm")}
              </Button>
            </>
          }
        >
          <p className="text-text-secondary">{t("edit.resetBody", { count: confirmReset })}</p>
        </Dialog>
      )}
      {deleting && (
        <Dialog
          title={t("edit.deleteTitle")}
          onClose={() => !busy && setDeleting(false)}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setDeleting(false)}>
                {t("edit.cancel")}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                {t("edit.delete")}
              </Button>
            </>
          }
        >
          <p className="text-text-secondary">{t("edit.deleteBody")}</p>
        </Dialog>
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function CronPreview({ cron, times, timezone }: { cron: string; times: string[]; timezone: string }) {
  const t = useTranslations("schedules");
  const format = useFormatter();
  const hydrated = useHydrated();
  return (
    <div className="flex flex-col gap-1 rounded-card bg-bg-subtle px-4 py-3">
      <span className="font-semibold">
        <CronLabel cron={cron} />
      </span>
      <span className="text-meta text-text-secondary">{t("edit.preview")}</span>
      <ol className="font-mono text-code text-text-secondary">
        {times.map((iso) => (
          <li key={iso}>{hydrated ? format.dateTime(new Date(iso), { dateStyle: "full", timeStyle: "short", timeZone: timezone }) : iso}</li>
        ))}
      </ol>
    </div>
  );
}

function ScheduleValuesPanel({ slug, scheduleId, environmentId, values, canWrite, onMessage }: { slug: string; scheduleId: string; environmentId: string; values: ScheduleValues; canWrite: boolean; onMessage: (text: string, tone?: "error") => void }) {
  const t = useTranslations("schedules");
  const format = useFormatter();
  const hydrated = useHydrated();
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const when = (iso: string) => (hydrated ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : "");

  async function put(variableId: string) {
    setBusy(true);
    const res = await api(`/api/w/${slug}/schedules/${scheduleId}/values/${variableId}`, "PUT", { value: drafts[variableId] ?? "" });
    setBusy(false);
    if (!res.ok) return onMessage(res.error?.message ?? t("edit.errorGeneric"), "error");
    setDrafts((d) => ({ ...d, [variableId]: "" }));
    router.refresh();
  }

  async function clear(variableId: string) {
    setBusy(true);
    await api(`/api/w/${slug}/schedules/${scheduleId}/values/${variableId}`, "DELETE");
    setBusy(false);
    router.refresh();
  }

  async function capture() {
    setBusy(true);
    const res = await api(`/api/w/${slug}/environments/${environmentId}/auth-session/capture`, "POST", { target: { kind: "schedule", scheduleId } });
    setBusy(false);
    if (res.ok) return onMessage(t("session.sent"));
    const code = res.error?.code;
    onMessage(code === "desktop_not_connected" ? t("session.errorDesktop") : code === "app_update_required" ? t("session.errorUpdate") : (res.error?.message ?? t("edit.errorGeneric")), "error");
  }

  const session = values.authSession;
  return (
    <>
      <section className="flex flex-col gap-3">
        <h2 className="text-title-sm">{t("values.title")}</h2>
        <p className="max-w-[640px] text-text-secondary">{t("values.intro")}</p>
        {values.variables.length === 0 ? (
          <p className="text-text-muted">{t("values.none")}</p>
        ) : (
          <div className="overflow-x-auto rounded-card border border-border bg-bg-surface shadow-e1">
            <table className="w-full text-left text-body">
              <tbody>
                {values.variables.map((v) => (
                  <tr key={v.id} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-3 font-mono text-code font-semibold">{v.key}</td>
                    <td className={`px-4 py-3 ${v.hasValue ? "text-pass" : "text-fail"}`}>{v.hasValue ? (v.isSecret ? t("values.secretSet") : t("values.set")) : t("values.notSet")}</td>
                    <td className="px-4 py-3">
                      {canWrite && (
                        <span className="flex items-center justify-end gap-2">
                          <Input
                            type={v.isSecret ? "password" : "text"}
                            autoComplete="off"
                            placeholder={v.isSecret ? "••••••" : (v.value ?? "")}
                            value={drafts[v.id] ?? ""}
                            onChange={(e) => setDrafts((d) => ({ ...d, [v.id]: e.target.value }))}
                          />
                          <Button variant="secondary" disabled={busy || (v.isSecret && !drafts[v.id])} onClick={() => void put(v.id)}>
                            {t("values.save")}
                          </Button>
                          {v.hasValue && (
                            <Button variant="secondary" disabled={busy} onClick={() => void clear(v.id)}>
                              {t("values.clear")}
                            </Button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-title-sm">{t("session.title")}</h2>
        {!session.required ? (
          <p className="text-text-muted">{t("session.notNeeded")}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            <span className={session.savedAt && !session.expired ? "text-pass" : session.savedAt ? "text-warn" : "text-fail"}>
              {session.savedAt && session.expiresAt
                ? session.expired
                  ? t("session.expired", { expires: when(session.expiresAt) })
                  : t("session.valid", { when: when(session.savedAt), expires: when(session.expiresAt) })
                : t("session.missing")}
            </span>
            {canWrite && (
              <Button variant="secondary" disabled={busy} onClick={() => void capture()}>
                {t("session.create")}
              </Button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
