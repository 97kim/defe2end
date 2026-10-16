"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Alert, Button } from "../../../../../components/ui";

// The caller's AI failure diagnosis consent (stage 6 contract section 8). Withdrawing makes the next diagnosis ask again.

const URL = "/api/account/ai-diagnosis-consent";

export function AiDiagnosisConsent() {
  const t = useTranslations("settings.aiDiagnosisConsent");
  const format = useFormatter();
  const [consentedAt, setConsentedAt] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void fetch(URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { consentedAt: string | null } | null) => setConsentedAt(body ? body.consentedAt : undefined))
      .catch(() => undefined);
  }, []);
  if (consentedAt === undefined) return null;

  async function withdraw() {
    setBusy(true);
    setFailed(false);
    const res = await fetch(URL, { method: "DELETE" }).catch(() => null);
    if (res?.ok) setConsentedAt(null);
    else setFailed(true);
    setBusy(false);
  }

  return (
    <section className="mb-8 space-y-3">
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      {failed && <Alert>{t("failed")}</Alert>}
      <div className="flex items-center justify-between gap-4 rounded border p-3">
        <p className="text-sm text-gray-600">{consentedAt ? t("agreed", { time: format.dateTime(new Date(consentedAt), { dateStyle: "medium", timeStyle: "short" }) }) : t("none")}</p>
        {consentedAt && (
          <Button variant="secondary" disabled={busy} onClick={() => void withdraw()}>
            {t("withdraw")}
          </Button>
        )}
      </div>
    </section>
  );
}
