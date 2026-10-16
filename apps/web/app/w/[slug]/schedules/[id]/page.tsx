import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { PageHeader } from "../../../../../components/ui";
import { ApiError } from "../../../../../lib/api";
import { canInWorkspace, requireWorkspace } from "../../../../../lib/page";
import { getSchedule, listFires, scheduleValues } from "../../../../../lib/schedules";
import { editorOptions } from "../editor-data";
import { FireHistory } from "../fire-history";
import { ScheduleEditor } from "../schedule-editor";

export default async function SchedulePage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const { workspace } = await requireWorkspace(slug);
  const schedule = await getSchedule(workspace.id, id).catch((err) => {
    if (err instanceof ApiError) notFound();
    throw err;
  });
  const [options, values, fires, canWrite, t] = await Promise.all([editorOptions(workspace.id), scheduleValues(workspace.id, id), listFires(workspace.id, id), canInWorkspace(slug, "schedule.write"), getTranslations("schedules")]);
  return (
    <>
      <PageHeader crumbs={[workspace.name, t("title")]} title={schedule.name} />
      <div className="flex flex-col gap-8 p-8">
        <ScheduleEditor slug={slug} options={options} defaultTimezone={workspace.timezone} schedule={schedule} values={values} canWrite={canWrite} />
        <FireHistory slug={slug} fires={fires} timezone={schedule.timezone} />
      </div>
    </>
  );
}
