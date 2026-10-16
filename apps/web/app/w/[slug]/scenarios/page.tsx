import { can } from "@defe2end/shared";
import { redirect } from "next/navigation";
import { requireWorkspace } from "../../../../lib/page";
import { scenarioListData, siteOptions } from "../../../../lib/scenario-pages";
import { ScenariosView } from "./scenarios-view";

/** Scenario list (full width); a scenario opens on its own page. Old `?s=<id>` links go there. */
export default async function ScenariosPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ s?: string | string[] }> }) {
  const { slug } = await params;
  const { s } = await searchParams;
  if (typeof s === "string" && s) redirect(`/w/${slug}/scenarios/${encodeURIComponent(s)}`);
  const { actor, workspace } = await requireWorkspace(slug);
  const canWrite = can(actor, "scenario.write", { type: "scenario", workspaceId: workspace.id }) === "allow";
  const [scenarios, sites] = await Promise.all([
    scenarioListData(workspace),
    siteOptions(workspace),
  ]);
  return (
    <div className="flex h-screen min-w-0 flex-col">
      <ScenariosView slug={slug} workspaceName={workspace.name} canWrite={canWrite} scenarios={scenarios} sites={sites} />
    </div>
  );
}
