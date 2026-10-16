"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "../../../components/accounts/badge";
import { LinkReveal } from "../../../components/accounts/link-reveal";
import { Alert, Avatar, Button, Dialog } from "../../../components/ui";
import { api } from "../../../lib/api-client";

interface User {
  id: string;
  name: string;
  email: string;
  isInstanceAdmin: boolean;
  disabled: boolean;
  workspaceCount: number;
}

export function UsersView({ users, currentUserId }: { users: User[]; currentUserId: string }) {
  const t = useTranslations("accounts");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [disabling, setDisabling] = useState<User>();
  const [link, setLink] = useState<{ email: string; url: string }>();

  async function setDisabled(user: User, disabled: boolean) {
    setBusy(true);
    setError(undefined);
    const res = await api(`/api/admin/users/${user.id}`, "PATCH", { disabled });
    setBusy(false);
    if (!res.ok) setError(res.status === 409 ? (user.id === currentUserId ? t("adminUsers.self") : t("adminUsers.lastAdmin")) : t("adminUsers.failed"));
    router.refresh();
  }

  async function issueReset(user: User) {
    setBusy(true);
    setError(undefined);
    const res = await api<{ token: string }>(`/api/admin/users/${user.id}/reset-link`, "POST", {});
    setBusy(false);
    if (!res.ok) return setError(t("adminUsers.failed"));
    setLink({ email: user.email, url: `${window.location.origin}/reset#token=${res.data!.token}` });
  }

  return (
    <div className="flex max-w-[960px] flex-col gap-3">
      <p className="text-meta text-text-muted">{t("adminUsers.description")}</p>
      {error && <Alert>{error}</Alert>}
      <div className="overflow-hidden rounded-card border border-border bg-bg-surface shadow-e1">
        <table className="w-full text-left">
          <thead className="border-b border-border bg-bg-subtle text-label uppercase tracking-wider text-text-muted">
            <tr>
              <th className="px-4 py-2.5 font-semibold">{t("adminUsers.colUser")}</th>
              <th className="px-4 py-2.5 font-semibold">{t("adminUsers.colWorkspaces")}</th>
              <th className="px-4 py-2.5 font-semibold">{t("adminUsers.colStatus")}</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map((u) => (
              <tr key={u.id} data-testid="user-row" className="hover:bg-bg-subtle">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={u.name} />
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate font-semibold">
                        {u.name}
                        {u.id === currentUserId && <Badge>{t("adminUsers.you")}</Badge>}
                        {u.isInstanceAdmin && <Badge>{t("adminUsers.instanceAdmin")}</Badge>}
                      </p>
                      <p className="truncate text-meta text-text-muted">{u.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-code">{u.workspaceCount}</td>
                <td className="px-4 py-3">{u.disabled ? <Badge tone="fail">{t("adminUsers.disabled")}</Badge> : <Badge>{t("adminUsers.active")}</Badge>}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    <Button variant="secondary" type="button" disabled={busy} onClick={() => issueReset(u)}>
                      {t("adminUsers.resetLink")}
                    </Button>
                    {u.disabled ? (
                      <Button variant="ghost" type="button" disabled={busy} onClick={() => setDisabled(u, false)}>
                        {t("adminUsers.enable")}
                      </Button>
                    ) : (
                      <Button variant="ghost" type="button" disabled={busy || u.id === currentUserId} onClick={() => setDisabling(u)}>
                        {t("adminUsers.disable")}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog
        open={Boolean(disabling)}
        title={disabling ? t("adminUsers.disableTitle", { name: disabling.name }) : ""}
        onClose={() => setDisabling(undefined)}
        footer={
          <>
            <Button variant="secondary" type="button" onClick={() => setDisabling(undefined)}>
              {t("adminUsers.cancel")}
            </Button>
            <Button
              variant="danger"
              type="button"
              disabled={busy}
              onClick={async () => {
                await setDisabled(disabling!, true);
                setDisabling(undefined);
              }}
            >
              {t("adminUsers.disableConfirm")}
            </Button>
          </>
        }
      >
        {disabling && <p className="text-text-secondary">{t("adminUsers.disableBody", { name: disabling.name })}</p>}
      </Dialog>

      <Dialog
        open={Boolean(link)}
        title={link ? t("adminUsers.linkTitle", { email: link.email }) : ""}
        onClose={() => setLink(undefined)}
        footer={
          <Button type="button" onClick={() => setLink(undefined)}>
            {t("adminUsers.done")}
          </Button>
        }
      >
        {link && (
          <div className="flex flex-col gap-3">
            <p className="text-text-secondary">{t("adminUsers.linkBody", { email: link.email })}</p>
            <LinkReveal url={link.url} copyLabel={t("adminUsers.copy")} copiedLabel={t("adminUsers.copied")} />
          </div>
        )}
      </Dialog>
    </div>
  );
}
