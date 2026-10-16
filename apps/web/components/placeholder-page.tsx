import { getTranslations } from "next-intl/server";
import { requireWorkspace } from "../lib/page";
import { EmptyState, PageHeader } from "./ui";

/** Temporary page body until the feature team replaces it. */
export async function PlaceholderPage({ slug, nav }: { slug: string; nav: "scenarios" | "runs" | "comparisons" | "schedules" | "settings" }) {
  const { workspace } = await requireWorkspace(slug);
  const t = await getTranslations("common");
  return (
    <>
      <PageHeader crumbs={[workspace.name]} title={t(`nav.${nav}`)} />
      <div className="p-8">
        <EmptyState title={t(`nav.${nav}`)} body={t("shell.placeholder")} />
      </div>
    </>
  );
}
