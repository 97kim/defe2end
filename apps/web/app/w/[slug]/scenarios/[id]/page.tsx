import { can } from "@defe2end/shared";
import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { getDb } from "../../../../../lib/db";
import { requireWorkspace } from "../../../../../lib/page";
import { WRITE_ENDPOINTS } from "../../../../../lib/run-endpoints";
import { scenarioDetailData, siteOptions } from "../../../../../lib/scenario-pages";
import { ScenarioDetailView } from "./scenario-detail-view";

/** One scenario: editor, test run, recording, last test run and history. Not this workspace's id → 404. */
export default async function ScenarioPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const { actor, workspace } = await requireWorkspace(slug);
  const data = await scenarioDetailData(workspace, id);
  if (!data) notFound();
  const format = await getFormatter();
  const [sites, tags] = await Promise.all([
    siteOptions(workspace),
    getDb().tag.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return (
    <div className="flex h-screen min-w-0 flex-col">
      <ScenarioDetailView
        slug={slug}
        userId={actor.userId}
        workspaceName={workspace.name}
        canWrite={can(actor, "scenario.write", { type: "scenario", workspaceId: workspace.id }) === "allow"}
        canRun={can(actor, "run.create", { type: "run", workspaceId: workspace.id }) === "allow"}
        scenario={{ ...data.scenario, editedAgo: format.relativeTime(data.updatedAt, new Date()) }}
        sites={sites}
        tags={tags}
        history={data.history}
        lastTestRunId={data.lastTestRunId}
        testRunAvailable={WRITE_ENDPOINTS.testRun.available}
      />
    </div>
  );
}
