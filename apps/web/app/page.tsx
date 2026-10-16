import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { CreateWorkspace } from "../components/create-workspace";
import { EmptyState } from "../components/ui";
import { getActor } from "../lib/actor";
import { listMyWorkspaces } from "../lib/page";
import { isSetupDone } from "../lib/setup";

export const dynamic = "force-dynamic";

export default async function Home() {
  const actor = await getActor(await headers());
  if (!actor) redirect((await isSetupDone()) ? "/login" : "/setup");
  const workspaces = await listMyWorkspaces(actor.userId);
  if (workspaces[0]) redirect(`/w/${workspaces[0].slug}/scenarios`);
  // No workspace yet (e.g. the last one was deleted): instance admins create one, others wait for an invite.
  const t = await getTranslations("settings.workspaces");
  return (
    <div className="px-6 py-24">
      <EmptyState title={t("noneTitle")} body={actor.isInstanceAdmin ? t("noneBodyAdmin") : t("noneBodyMember")}>
        {actor.isInstanceAdmin && <CreateWorkspace variant="primary" />}
      </EmptyState>
    </div>
  );
}
