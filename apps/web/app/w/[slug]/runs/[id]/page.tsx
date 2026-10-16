import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "../../../../../components/ui";
import { canInWorkspace, requireWorkspace } from "../../../../../lib/page";
import { WRITE_ENDPOINTS } from "../../../../../lib/run-endpoints";
import { findRunDetail, getRunChanges } from "../../../../../lib/run-read";
import { shortRunId } from "../run-ui";
import { RunView } from "./run-view";

// ap-2 result, s-2 running (live over SSE), s-4 infrastructure error. s-3 is loading.tsx.
export default async function RunPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const { workspace } = await requireWorkspace(slug);
  if (!(await canInWorkspace(slug, "run.read"))) notFound();
  const run = await findRunDetail(workspace, id);
  if (!run) notFound();
  const [changes, canCancel, canCreate, t, tNav] = await Promise.all([
    getRunChanges(workspace.id, run.id),
    canInWorkspace(slug, "run.cancel"),
    canInWorkspace(slug, "run.create"),
    getTranslations("runs"),
    getTranslations("common"),
  ]);
  return (
    <>
      <PageHeader crumbs={[workspace.name, tNav("nav.runs")]} title={t("pageTitle", { id: shortRunId(run.id) })} />
      <RunView slug={slug} initial={run} changes={changes} can={{ cancel: canCancel, create: canCreate }} rerunFailedAvailable={WRITE_ENDPOINTS.rerunFailed.available} />
    </>
  );
}
