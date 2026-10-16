"use client";

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useHydrated } from "../runs/use-hydrated";
import { FireStatus } from "./schedule-ui";

export interface FireRow {
  id: string;
  scheduledFor: string;
  status: string;
  reasonCode: string | null;
  missedUntil: string | null;
  missedCount: number | null;
  runId: string | null;
}

export function FireHistory({ slug, fires, timezone }: { slug: string; fires: FireRow[]; timezone: string }) {
  const t = useTranslations("schedules");
  const format = useFormatter();
  const hydrated = useHydrated();
  const when = (iso: string) => (hydrated ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short", timeZone: timezone }) : "");
  return (
    <section className="flex max-w-[960px] flex-col gap-3">
      <h2 className="text-title-sm">{t("fires.title")}</h2>
      {fires.length === 0 ? (
        <p className="text-text-muted">{t("fires.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border bg-bg-surface shadow-e1">
          <table className="w-full text-left text-body">
            <thead className="border-b border-border bg-bg-subtle text-meta text-text-secondary">
              <tr>
                <th className="px-4 py-2 font-semibold">{t("fires.planned")}</th>
                <th className="px-4 py-2 font-semibold">{t("fires.status")}</th>
                <th className="px-4 py-2 font-semibold">{t("fires.detail")}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {fires.map((f) => (
                <tr key={f.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-3 font-mono text-code text-text-secondary">{when(f.scheduledFor)}</td>
                  <td className="px-4 py-3">
                    <FireStatus status={f.status} reasonCode={f.reasonCode} />
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {f.status === "missed" && f.missedUntil && f.missedCount ? t("fires.missedRange", { count: f.missedCount, until: when(f.missedUntil) }) : null}
                    {f.reasonCode ? (t.has(`reason.${f.reasonCode}` as "reason.internal") ? t(`reason.${f.reasonCode}` as "reason.internal") : f.reasonCode) : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {f.runId && (
                      <Link href={`/w/${slug}/runs/${f.runId}`} className="text-accent hover:underline">
                        {t("fires.openRun")}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
