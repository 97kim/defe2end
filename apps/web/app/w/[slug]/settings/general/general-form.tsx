"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Chip, Dialog, Field, Input } from "../../../../../components/ui";
import { api } from "../../../../../lib/api-client";

export function GeneralForm({ slug, name, canEdit }: { slug: string; name: string; canEdit: boolean }) {
  const t = useTranslations("settings");
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const errorText = (code?: string) => (code === "forbidden" ? t("errors.forbidden") : t("errors.generic"));

  async function rename() {
    if (!value.trim()) return setError(t("general.nameRequired"));
    setPending(true);
    setError(undefined);
    setSaved(false);
    const res = await api(`/api/w/${slug}`, "PATCH", { name: value });
    setPending(false);
    if (!res.ok) return setError(errorText(res.error?.code));
    setSaved(true);
    router.refresh();
  }

  return (
    <>
      <section className="rounded-card border border-border bg-bg-surface shadow-e1">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
          className="flex flex-col gap-4 p-6"
        >
          <div>
            <h2 className="text-title-sm">{t("general.heading")}</h2>
            <p className="text-text-muted">{t("general.description")}</p>
          </div>
          <Field label={t("general.name")}>
            <Input
              name="name"
              value={value}
              maxLength={100}
              required
              disabled={!canEdit}
              onChange={(e) => {
                setValue(e.target.value);
                setSaved(false);
              }}
            />
          </Field>
          <Field label={t("general.slug")} hint={t("general.slugHint")}>
            <Input value={slug} readOnly disabled className="font-mono" />
          </Field>
          {error && <Alert>{error}</Alert>}
          {canEdit && (
            <div className="flex items-center justify-end gap-3">
              {saved && (
                <span role="status" className="text-meta text-pass">
                  {t("general.saved")}
                </span>
              )}
              <Button type="submit" disabled={pending || value.trim() === name}>
                {pending ? t("actions.saving") : t("actions.save")}
              </Button>
            </div>
          )}
        </form>
      </section>

      {canEdit && (
        <section className="flex items-center justify-between gap-6 rounded-card border border-fail/30 bg-bg-surface p-6 shadow-e1">
          <div>
            <h2 className="text-title-sm text-fail">{t("general.dangerHeading")}</h2>
            <p className="text-text-secondary">{t("general.dangerBody")}</p>
          </div>
          <Button variant="danger" className="shrink-0" onClick={() => setDeleting(true)}>
            {t("general.deleteButton")}
          </Button>
        </section>
      )}

      <DeleteWorkspaceDialog open={deleting} slug={slug} name={name} onClose={() => setDeleting(false)} />
    </>
  );
}

const LOCALES = [
  { value: "en", label: "English" },
  { value: "ko", label: "한국어" },
] as const;

/** Message language of Slack notifications and the workspace time zone (schedules, dashboard days). */
export function RegionForm({ slug, locale, timezone, canEdit }: { slug: string; locale: string; timezone: string; canEdit: boolean }) {
  const t = useTranslations("settings");
  const router = useRouter();
  const [lang, setLang] = useState(locale === "ko" ? "ko" : "en");
  const [zone, setZone] = useState(timezone);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  async function save() {
    setPending(true);
    setError(undefined);
    setSaved(false);
    const res = await api(`/api/w/${slug}`, "PATCH", { locale: lang, timezone: zone.trim() });
    setPending(false);
    if (!res.ok) return setError(res.error?.code === "forbidden" ? t("errors.forbidden") : res.error?.code === "invalid_request" ? t("general.timezoneInvalid") : t("errors.generic"));
    setSaved(true);
    router.refresh();
  }

  return (
    <section className="rounded-card border border-border bg-bg-surface shadow-e1">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4 p-6"
      >
        <div>
          <h2 className="text-title-sm">{t("general.regionHeading")}</h2>
          <p className="text-text-muted">{t("general.regionDescription")}</p>
        </div>
        <Field label={t("general.locale")} hint={t("general.localeHint")}>
          <div className="flex gap-2">
            {LOCALES.map((l) => (
              <Chip
                key={l.value}
                active={lang === l.value}
                disabled={!canEdit}
                onClick={() => {
                  setLang(l.value);
                  setSaved(false);
                }}
              >
                {l.label}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label={t("general.timezone")} hint={t("general.timezoneHint")}>
          <Input
            name="timezone"
            value={zone}
            required
            disabled={!canEdit}
            className="font-mono"
            onChange={(e) => {
              setZone(e.target.value);
              setSaved(false);
            }}
          />
        </Field>
        {error && <Alert>{error}</Alert>}
        {canEdit && (
          <div className="flex items-center justify-end gap-3">
            {saved && (
              <span role="status" className="text-meta text-pass">
                {t("general.saved")}
              </span>
            )}
            <Button type="submit" disabled={pending || !zone.trim() || (lang === locale && zone.trim() === timezone)}>
              {pending ? t("actions.saving") : t("actions.save")}
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}

function DeleteWorkspaceDialog({ open, slug, name, onClose }: { open: boolean; slug: string; name: string; onClose: () => void }) {
  const t = useTranslations("settings");
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  function close() {
    setTyped("");
    setError(undefined);
    onClose();
  }

  async function submit() {
    if (typed !== name) return setError(t("general.deleteMismatch"));
    setPending(true);
    const res = await api(`/api/w/${slug}`, "DELETE", { confirmName: typed });
    setPending(false);
    if (!res.ok) return setError(res.error?.code === "forbidden" ? t("errors.forbidden") : t("errors.generic"));
    router.replace("/");
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      title={t("general.deleteTitle", { name })}
      onClose={close}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close}>
            {t("actions.cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={pending || typed !== name}>
            {t("general.deleteConfirm")}
          </Button>
        </>
      }
    >
      <p className="text-text-secondary">{t("general.deleteBody")}</p>
      <Field label={t("general.deleteConfirmLabel", { name })}>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus aria-invalid={Boolean(error)} />
      </Field>
      {error && <Alert>{error}</Alert>}
    </Dialog>
  );
}
