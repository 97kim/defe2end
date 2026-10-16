"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Toggle } from "../../../../components/ui";
import { api } from "../../../../lib/api-client";

export function ScheduleToggle({ slug, scheduleId, enabled, disabled }: { slug: string; scheduleId: string; enabled: boolean; disabled: boolean }) {
  const t = useTranslations("schedules");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Toggle
      checked={enabled}
      label={t("columns.enabled")}
      disabled={disabled || busy}
      onChange={async (checked) => {
        setBusy(true);
        await api(`/api/w/${slug}/schedules/${scheduleId}`, "PATCH", { enabled: checked });
        setBusy(false);
        router.refresh();
      }}
    />
  );
}
