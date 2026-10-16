"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Alert, Button, Dialog } from "../../../../components/ui";
import { api } from "../../../../lib/api-client";
import type { SkipReason } from "../../../../lib/scenario-helpers";
import { UploadIcon } from "./icons";

interface Summary {
  total: number;
  created: { name: string; site: string; stepCount: number }[];
  skipped: { index: number; name: string | null; reason: SkipReason; detail: string }[];
}

/** Pick a file → dry-run preview (created / skipped with reasons) → confirm. */
export function ImportDialog({ slug, onClose, onImported }: { slug: string; onClose: () => void; onImported: (count: number) => void }) {
  const t = useTranslations("scenarios.importDialog");
  const [file, setFile] = useState<{ name: string; json: unknown }>();
  const [preview, setPreview] = useState<Summary>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const path = `/api/w/${slug}/scenarios/import`;

  async function choose(input: HTMLInputElement) {
    const picked = input.files?.[0];
    input.value = "";
    if (!picked) return;
    setPreview(undefined);
    setError(undefined);
    let json: unknown;
    try {
      json = JSON.parse(await picked.text());
    } catch {
      setFile(undefined);
      return setError(t("notJson"));
    }
    setFile({ name: picked.name, json });
    setPending(true);
    const res = await api<Summary>(path, "POST", { file: json, dryRun: true });
    setPending(false);
    if (!res.ok) return setError(res.error?.message);
    setPreview(res.data);
  }

  async function confirm() {
    if (!file) return;
    setPending(true);
    const res = await api<Summary>(path, "POST", { file: file.json });
    setPending(false);
    if (!res.ok) return setError(res.error?.message);
    onImported(res.data!.created.length);
  }

  return (
    <Dialog
      wide
      title={t("title")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button onClick={confirm} disabled={pending || !preview || preview.created.length === 0}>
            {t("confirm", { count: preview?.created.length ?? 0 })}
          </Button>
        </>
      }
    >
      <p className="text-text-secondary">{t("description")}</p>
      <label className="flex cursor-pointer items-center gap-3 rounded-item border border-dashed border-border-strong bg-bg-subtle px-4 py-3 hover:bg-accent-soft">
        <UploadIcon />
        <span className="font-semibold">{t("choose")}</span>
        <span className="truncate font-mono text-code text-text-muted">{file?.name}</span>
        <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => choose(e.currentTarget)} />
      </label>
      {error && <Alert>{error}</Alert>}
      {preview && (
        <section aria-label={t("preview")}>
          <p className="font-semibold">{t("willCreate", { count: preview.created.length })}</p>
          {preview.created.length > 0 && (
            <ul className="mt-1.5 max-h-40 overflow-y-auto rounded-control border border-border">
              {preview.created.map((c, i) => (
                <li key={i} className="flex justify-between gap-3 border-b border-border px-3 py-1.5 last:border-0">
                  <span className="truncate">{c.name}</span>
                  <span className="shrink-0 font-mono text-code text-text-muted">
                    {c.site} · {c.stepCount}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {preview.skipped.length > 0 && (
            <>
              <p className="mt-3 font-semibold text-fail">{t("willSkip", { count: preview.skipped.length })}</p>
              <ul className="mt-1.5 max-h-40 overflow-y-auto rounded-control border border-fail/30 bg-fail-soft">
                {preview.skipped.map((s) => (
                  <li key={s.index} className="border-b border-fail/20 px-3 py-1.5 last:border-0">
                    <span className="font-semibold">{s.name ?? t("unnamed", { index: s.index + 1 })}</span>
                    <span className="block text-meta text-text-secondary">
                      {s.reason === "site_not_found" ? t("reason_site_not_found", { detail: s.detail }) : t("reason_invalid", { detail: s.detail })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </Dialog>
  );
}
