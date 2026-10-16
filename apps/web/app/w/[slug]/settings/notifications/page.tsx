import { getTranslations } from "next-intl/server";
import { ViewOnlyBanner } from "../../../../../components/ui";
import { getDb } from "../../../../../lib/db";
import { webhookView } from "../../../../../lib/notifications";
import { canInWorkspace, requireWorkspace } from "../../../../../lib/page";
import { NotificationsManager } from "./notifications-manager";

export default async function NotificationsSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const canWrite = await canInWorkspace(slug, "notification.write");
  const t = await getTranslations("settings");
  const hooks = await getDb().slackWebhook.findMany({ where: { workspaceId: workspace.id }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      {!canWrite && <ViewOnlyBanner title={t("viewOnly.title", { workspace: workspace.name })} body={t("notifications.viewOnly")} />}
      <NotificationsManager slug={slug} webhooks={hooks.map(webhookView)} canWrite={canWrite} defaultTimezone={workspace.timezone} />
    </div>
  );
}
