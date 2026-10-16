import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { buttonClass, EmptyState, PageHeader } from "../../../../components/ui";
import { canInWorkspace, requireWorkspace } from "../../../../lib/page";
import { listSchedules } from "../../../../lib/schedules";
import { CronLabel, FireStatus } from "./schedule-ui";
import { ScheduleToggle } from "./schedule-toggle";

export default async function SchedulesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const [schedules, canWrite, t, format] = await Promise.all([listSchedules(workspace.id), canInWorkspace(slug, "schedule.write"), getTranslations("schedules"), getFormatter()]);
  const when = (iso: string, timeZone: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short", timeZone });
  return (
    <>
      <PageHeader
        crumbs={[workspace.name]}
        title={t("title")}
        actions={
          canWrite ? (
            <Link href={`/w/${slug}/schedules/new`} className={buttonClass()}>
              {t("new")}
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4 p-8">
        {!canWrite && <p className="text-meta text-text-muted">{t("viewerHint")}</p>}
        {schedules.length === 0 ? (
          <EmptyState title={t("empty")} body={t("emptyBody")} />
        ) : (
          <section className="overflow-x-auto rounded-card border border-border bg-bg-surface shadow-e1">
            <table className="w-full text-left text-body">
              <thead className="border-b border-border bg-bg-subtle text-meta text-text-secondary">
                <tr>
                  <th className="px-4 py-2 font-semibold">{t("columns.name")}</th>
                  <th className="px-4 py-2 font-semibold">{t("columns.target")}</th>
                  <th className="px-4 py-2 font-semibold">{t("columns.when")}</th>
                  <th className="px-4 py-2 font-semibold">{t("columns.timezone")}</th>
                  <th className="px-4 py-2 font-semibold">{t("columns.next")}</th>
                  <th className="px-4 py-2 font-semibold">{t("columns.last")}</th>
                  <th className="px-4 py-2 font-semibold">{t("columns.enabled")}</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id} className="border-b border-border transition-colors duration-fast last:border-b-0 hover:bg-bg-subtle">
                    <td className="px-4 py-3">
                      <Link href={`/w/${slug}/schedules/${s.id}`} className="font-semibold hover:underline">
                        {s.name}
                      </Link>
                      <span className="block text-meta text-text-muted">{s.environmentName}</span>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{s.tagId ? t("target.tag", { tag: s.tagName ?? "" }) : t("target.scenarios", { count: s.scenarioIds.length })}</td>
                    <td className="px-4 py-3">
                      <CronLabel cron={s.cron} />
                    </td>
                    <td className="px-4 py-3 font-mono text-code text-text-secondary">{s.timezone}</td>
                    <td className="px-4 py-3 font-mono text-code text-text-secondary">{s.nextRunAt ? when(s.nextRunAt, s.timezone) : t("never")}</td>
                    <td className="px-4 py-3">{s.lastFire ? <FireStatus status={s.lastFire.status} reasonCode={s.lastFire.reasonCode} /> : t("never")}</td>
                    <td className="px-4 py-3">
                      <ScheduleToggle slug={slug} scheduleId={s.id} enabled={s.enabled} disabled={!canWrite} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </>
  );
}
