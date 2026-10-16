import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "../../../../../components/ui";
import { canInWorkspace, requireWorkspace } from "../../../../../lib/page";
import { editorOptions } from "../editor-data";
import { ScheduleEditor } from "../schedule-editor";

export default async function NewSchedulePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  if (!(await canInWorkspace(slug, "schedule.write"))) notFound();
  const [options, t] = await Promise.all([editorOptions(workspace.id), getTranslations("schedules")]);
  return (
    <>
      <PageHeader crumbs={[workspace.name, t("title")]} title={t("edit.titleNew")} />
      <div className="p-8">
        <ScheduleEditor slug={slug} options={options} defaultTimezone={workspace.timezone} canWrite />
      </div>
    </>
  );
}
