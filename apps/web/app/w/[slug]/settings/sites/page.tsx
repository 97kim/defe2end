import { getTranslations } from "next-intl/server";
import { ViewOnlyBanner } from "../../../../../components/ui";
import { getDb } from "../../../../../lib/db";
import { canInWorkspace, requireWorkspace } from "../../../../../lib/page";
import { environmentView, ownPersonalValue, siteView, variableView } from "../../../../../lib/site-config";
import { SitesManager } from "./sites-manager";

export default async function SitesSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { workspace, actor } = await requireWorkspace(slug);
  const canWrite = await canInWorkspace(slug, "config.write");
  const canWriteMine = await canInWorkspace(slug, "variable.personal.write");
  const t = await getTranslations("settings");
  const sites = await getDb().site.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { name: "asc" },
    include: { environments: { orderBy: { name: "asc" }, include: { variables: { orderBy: { key: "asc" }, include: ownPersonalValue(actor.userId) } } } },
  });
  // Same views as the API: secret values never reach the browser.
  const data = sites.map((s) => ({
    ...siteView(s),
    environments: s.environments.map((e) => ({ ...environmentView(e), variables: e.variables.map((v) => variableView(v, v.personalValues[0])) })),
  }));
  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      {!canWrite && <ViewOnlyBanner title={t("viewOnly.title", { workspace: workspace.name })} body={t("viewOnly.bodyConfig")} />}
      <SitesManager slug={slug} sites={data} canWrite={canWrite} canWriteMine={canWriteMine} />
    </div>
  );
}
