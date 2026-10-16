import { getTranslations } from "next-intl/server";
import { ViewOnlyBanner } from "../../../../../components/ui";
import { canInWorkspace, requireWorkspace } from "../../../../../lib/page";
import { GeneralForm, RegionForm } from "./general-form";

export default async function GeneralSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const isAdmin = await canInWorkspace(slug, "workspace.admin");
  const t = await getTranslations("settings");
  return (
    <div className="flex max-w-[720px] flex-col gap-6">
      {!isAdmin && <ViewOnlyBanner title={t("viewOnly.title", { workspace: workspace.name })} body={t("viewOnly.bodyAdmin")} />}
      <GeneralForm slug={workspace.slug} name={workspace.name} canEdit={isAdmin} />
      <RegionForm slug={workspace.slug} locale={workspace.locale} timezone={workspace.timezone} canEdit={isAdmin} />
    </div>
  );
}
