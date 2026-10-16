import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonClass, EmptyState } from "../../../../../components/ui";

/** A scenario id that isn't in this workspace (deleted, mistyped, or another workspace's). */
export default async function ScenarioNotFound() {
  const t = await getTranslations("scenarios.detail");
  return (
    <div className="p-8">
      <EmptyState title={t("notFoundTitle")} body={t("notFoundBody")}>
        <Link href="." className={buttonClass("secondary")}>
          ← {t("back")}
        </Link>
      </EmptyState>
    </div>
  );
}
