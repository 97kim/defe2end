import { getTranslations } from "next-intl/server";

export default async function Loading() {
  const t = await getTranslations("scenarios.detail");
  return <p className="p-8 text-text-muted">{t("loading")}</p>;
}
