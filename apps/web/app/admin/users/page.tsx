import Link from "next/link";
import { can } from "@defe2end/shared";
import { getTranslations } from "next-intl/server";
import { AccessDenied } from "../../../components/access-denied";
import { PageHeader, Wordmark } from "../../../components/ui";
import { listUsers } from "../../../lib/accounts/reset-links";
import { requireActor } from "../../../lib/page";
import { UsersView } from "./users-view";

export const dynamic = "force-dynamic";

/** Instance admin: users, disable/enable, one-time reset links. */
export default async function AdminUsersPage() {
  const actor = await requireActor();
  if (can(actor, "user.list", { type: "instance" }) !== "allow") return <AccessDenied kind="forbidden" />;
  const t = await getTranslations("accounts.adminUsers");
  const users = await listUsers();
  return (
    <div className="min-h-screen">
      <div className="border-b border-border bg-bg-surface px-8 py-3">
        <Link href="/">
          <Wordmark />
        </Link>
      </div>
      <PageHeader crumbs={[t("crumb")]} title={t("title")} />
      <div className="p-8">
        <UsersView users={users} currentUserId={actor.userId} />
      </div>
    </div>
  );
}
