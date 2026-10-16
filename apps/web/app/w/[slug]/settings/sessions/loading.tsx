import { getTranslations } from "next-intl/server";

export default async function Loading() {
  const t = await getTranslations("settings.authSessions");
  return <p className="text-text-muted">{t("loading")}</p>;
}
