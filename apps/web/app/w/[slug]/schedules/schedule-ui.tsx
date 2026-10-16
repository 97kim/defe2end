"use client";

import { useTranslations } from "next-intl";
import { describeCron } from "./cron-text";

/** The expression in words when it has a common shape, else the expression itself. */
export function CronLabel({ cron }: { cron: string }) {
  const t = useTranslations("schedules");
  const text = describeCron(cron);
  if (!text) return <span className="font-mono text-code">{cron}</span>;
  if (text.key === "everyMinute") return <span title={cron}>{t("cron.everyMinute")}</span>;
  if (text.key === "weekly") return <span title={cron}>{t("cron.weekly", { time: text.values.time, days: text.values.days.map((d) => t(`days.${d}` as "days.0")).join(", ") })}</span>;
  return <span title={cron}>{t(`cron.${text.key}`, text.values as never)}</span>;
}

export const FIRE_TONE: Record<string, string> = { started: "text-pass", skipped_overlap: "text-warn", missed: "text-warn", refused: "text-fail", error: "text-fail" };

export function FireStatus({ status, reasonCode }: { status: string; reasonCode: string | null }) {
  const t = useTranslations("schedules");
  return (
    <span className={`font-semibold ${FIRE_TONE[status] ?? ""}`} title={reasonCode ? t.has(`reason.${reasonCode}` as "reason.internal") ? t(`reason.${reasonCode}` as "reason.internal") : reasonCode : undefined}>
      {t(`fireStatus.${status}` as "fireStatus.started")}
    </span>
  );
}
