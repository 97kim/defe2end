"use client";

import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useRef, useState, type FormEvent } from "react";
import { Alert, Button, Dialog, Field, Input, Toasts, useToasts } from "../../../../../components/ui";
import type { AttachmentVersionView, AttachmentView } from "../../../../../lib/attachments";
import { endpointUrl } from "../../../../../lib/run-endpoints";
import { useHydrated } from "../../runs/use-hydrated";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function AttachmentsManager({ slug, attachments, canWrite, uploadAvailable }: { slug: string; attachments: AttachmentView[]; canWrite: boolean; uploadAvailable: boolean }) {
  const t = useTranslations("settings.attachments");
  const format = useFormatter();
  const hydrated = useHydrated();
  const router = useRouter();
  const { toasts, push, dismiss } = useToasts();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<{ name: string; v: AttachmentVersionView } | null>(null);

  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return setError(t("tooLarge"));
    setBusy(true);
    setError(undefined);
    const form = new FormData();
    form.set("file", file);
    form.set("name", name.trim() || file.name);
    const res = await fetch(endpointUrl(slug, "attachmentUpload"), { method: "POST", body: form });
    const body = await res.json().catch(() => undefined);
    setBusy(false);
    if (!res.ok) return setError(body?.error?.message ?? t("failed"));
    push(t("uploaded", { name: body.name, version: body.version }));
    setName("");
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    const res = await fetch(deleting.v.url, { method: "DELETE" });
    const body = res.ok ? undefined : await res.json().catch(() => undefined);
    setBusy(false);
    const { name: n, v } = deleting;
    setDeleting(null);
    if (!res.ok) return push(t("deleteFailed", { message: body?.error?.message ?? res.statusText }), "error");
    push(t("deleted", { name: n, version: v.version }));
    router.refresh();
  }

  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <section className="rounded-card border border-border bg-bg-surface p-6 shadow-e1">
        <h2 className="text-title-md">{t("title")}</h2>
        <p className="mt-1 max-w-[640px] text-text-secondary">{t("body")}</p>
        {canWrite ? (
          <form onSubmit={upload} className="mt-5 flex flex-wrap items-end gap-3">
            <Field label={t("file")}>
              <input ref={fileRef} type="file" required disabled={!uploadAvailable || busy} className="text-body file:mr-3 file:rounded-control file:border file:border-border-strong file:bg-bg-surface file:px-3 file:py-1.5 file:font-semibold" />
            </Field>
            <Field label={t("name")}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} disabled={!uploadAvailable || busy} className="w-64 font-mono" />
            </Field>
            <Button type="submit" disabled={!uploadAvailable || busy}>
              {busy ? t("uploading") : t("upload")}
            </Button>
            <p className="w-full text-meta text-text-muted">{uploadAvailable ? t("limit") : t("uploadComing")}</p>
          </form>
        ) : (
          <p className="mt-4 text-meta text-text-muted">{t("viewerBody")}</p>
        )}
        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}
      </section>

      <section className="rounded-card border border-border bg-bg-surface shadow-e1">
        {attachments.length === 0 ? (
          <p className="px-6 py-8 text-center text-text-muted">{t("empty")}</p>
        ) : (
          <ul>
            {attachments.map((a) => (
              <li key={a.name} className="border-b border-border px-6 py-4 last:border-b-0">
                <p className="font-mono text-code font-semibold">{a.name}</p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {a.versions.map((v, i) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-3 text-meta">
                      <span className="w-10 font-mono">{t("version", { version: v.version })}</span>
                      {i === 0 && <span className="rounded-tag bg-pass-soft px-1.5 font-semibold text-pass">{t("latest")}</span>}
                      <span className="font-mono text-text-muted">{formatBytes(v.sizeBytes)}</span>
                      <span className="text-text-muted">{hydrated && format.dateTime(new Date(v.createdAt), { dateStyle: "medium", timeStyle: "short" })}</span>
                      <span className="ml-auto flex gap-3">
                        <a href={v.url} download className="font-semibold underline underline-offset-2">
                          {t("download")}
                        </a>
                        {canWrite && (
                          <button type="button" className="font-semibold text-fail underline underline-offset-2" onClick={() => setDeleting({ name: a.name, v })}>
                            {t("delete")}
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      {deleting && (
        <Dialog
          title={t("deleteTitle", { name: deleting.name, version: deleting.v.version })}
          onClose={() => !busy && setDeleting(null)}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setDeleting(null)}>
                {t("keep")}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                {t("deleteConfirm")}
              </Button>
            </>
          }
        >
          <p className="text-text-secondary">{t("deleteBody")}</p>
        </Dialog>
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.ceil(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
