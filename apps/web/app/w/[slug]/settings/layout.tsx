import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { PageHeader, Tabs } from "../../../../components/ui";
import { requireWorkspace } from "../../../../lib/page";

/** Header and tabs for every settings page; pages render only their body. */
export default async function SettingsLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const t = await getTranslations("settings");
  const base = `/w/${slug}/settings`;
  return (
    <>
      <PageHeader crumbs={[workspace.name]} title={t("title")} />
      <Tabs
        label={t("tabs.label")}
        tabs={[
          { href: `${base}/general`, label: t("tabs.general") },
          { href: `${base}/members`, label: t("tabs.members") },
          { href: `${base}/sites`, label: t("tabs.sites") },
          { href: `${base}/attachments`, label: t("tabs.attachments") },
          { href: `${base}/sessions`, label: t("tabs.authSessions") },
          { href: `${base}/notifications`, label: t("tabs.notifications") },
          { href: `${base}/bot-tokens`, label: t("tabs.botTokens") },
        ]}
      />
      <div className="p-8">{children}</div>
    </>
  );
}
