"use client";

import { ROLES, type Role } from "@defe2end/shared";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Badge } from "../../../../../components/accounts/badge";
import { LinkReveal } from "../../../../../components/accounts/link-reveal";
import { Alert, Avatar, Button, Dialog, Field, Input, inputClass } from "../../../../../components/ui";
import { api } from "../../../../../lib/api-client";

interface Member {
  id: string;
  role: Role;
  joinedAt: string;
  user: { id: string; name: string; email: string; disabled: boolean };
}
interface Invite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdBy: string;
}

const selectClass = `${inputClass} w-auto pr-8`;

export function MembersView({ slug, isAdmin, currentUserId, members, invites }: { slug: string; isAdmin: boolean; currentUserId: string; members: Member[]; invites: Invite[] }) {
  const t = useTranslations("accounts");
  const tc = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<Member>();
  const [revoking, setRevoking] = useState<Invite>();
  const [busy, setBusy] = useState(false);
  const base = `/api/w/${slug}`;
  const activeAdminCount = members.filter((m) => m.role === "ADMIN" && !m.user.disabled).length;

  async function run(call: Promise<{ ok: boolean; status: number }>) {
    setBusy(true);
    setError(undefined);
    const res = await call;
    setBusy(false);
    if (!res.ok) setError(res.status === 409 ? t("members.lastAdmin") : t("members.failed"));
    router.refresh();
    return res.ok;
  }

  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });

  return (
    <div className="flex max-w-[880px] flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-title-sm">{t("members.title")}</h2>
            <p className="text-meta text-text-muted">{t("members.description")}</p>
          </div>
        </div>
        {!isAdmin && <Alert tone="info">{t("members.readOnly")}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div className="overflow-hidden rounded-card border border-border bg-bg-surface shadow-e1">
          <table className="w-full text-left">
            <thead className="border-b border-border bg-bg-subtle text-label uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-4 py-2.5 font-semibold">{t("members.colName")}</th>
                <th className="px-4 py-2.5 font-semibold">{t("members.colRole")}</th>
                <th className="px-4 py-2.5 font-semibold">{t("members.colJoined")}</th>
                {isAdmin && <th className="px-4 py-2.5" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members.map((m) => {
                const lockedLastAdmin = m.role === "ADMIN" && !m.user.disabled && activeAdminCount <= 1;
                return (
                  <tr key={m.id} data-testid="member-row" className="hover:bg-bg-subtle">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={m.user.name} />
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 truncate font-semibold">
                            {m.user.name}
                            {m.user.id === currentUserId && <Badge>{t("members.you")}</Badge>}
                            {m.user.disabled && <Badge tone="fail">{t("members.disabled")}</Badge>}
                          </p>
                          <p className="truncate text-meta text-text-muted">{m.user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {isAdmin ? (
                        <select
                          aria-label={t("members.changeRole", { name: m.user.name })}
                          className={selectClass}
                          value={m.role}
                          disabled={busy}
                          onChange={(e) => run(api(`${base}/members/${m.id}`, "PATCH", { role: e.target.value }))}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r} disabled={lockedLastAdmin && r !== "ADMIN"}>
                              {tc(`roles.${r}`)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge>{tc(`roles.${m.role}`)}</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-meta text-text-muted">{date(m.joinedAt)}</td>
                    {isAdmin && (
                      <td className="px-4 py-3 text-right">
                        <Button variant="ghost" type="button" disabled={busy || lockedLastAdmin} onClick={() => setRemoving(m)}>
                          {t("members.remove")}
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {isAdmin && (
        <section className="flex flex-col gap-3">
          <div className="flex items-end justify-between gap-4">
            <h2 className="text-title-sm">{t("invites.title")}</h2>
          </div>
          <InviteForm base={base} onCreated={() => router.refresh()} />
          <div className="overflow-hidden rounded-card border border-border bg-bg-surface shadow-e1">
            {invites.length === 0 ? (
              <p className="px-4 py-4 text-text-muted">{t("invites.empty")}</p>
            ) : (
              <ul className="divide-y divide-border">
                {invites.map((i) => (
                  <li key={i.id} data-testid="invite-row" className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{i.email}</p>
                      <p className="text-meta text-text-muted">
                        {t("invites.invitedBy", { name: i.createdBy })} · {t("invites.expires", { date: format.dateTime(new Date(i.expiresAt), { dateStyle: "medium", timeStyle: "short" }) })}
                      </p>
                    </div>
                    <Badge>{tc(`roles.${i.role}`)}</Badge>
                    <Button variant="ghost" type="button" disabled={busy} onClick={() => setRevoking(i)}>
                      {t("invites.revoke")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      <Dialog
        open={Boolean(removing)}
        title={removing ? t("members.removeTitle", { name: removing.user.name }) : ""}
        onClose={() => setRemoving(undefined)}
        footer={
          <>
            <Button variant="secondary" type="button" onClick={() => setRemoving(undefined)}>
              {t("members.cancel")}
            </Button>
            <Button
              variant="danger"
              type="button"
              disabled={busy}
              onClick={async () => {
                await run(api(`${base}/members/${removing!.id}`, "DELETE"));
                setRemoving(undefined);
              }}
            >
              {t("members.removeConfirm")}
            </Button>
          </>
        }
      >
        {removing && <p className="text-text-secondary">{t("members.removeBody", { name: removing.user.name })}</p>}
      </Dialog>

      <Dialog
        open={Boolean(revoking)}
        title={revoking ? t("invites.revokeTitle", { email: revoking.email }) : ""}
        onClose={() => setRevoking(undefined)}
        footer={
          <>
            <Button variant="secondary" type="button" onClick={() => setRevoking(undefined)}>
              {t("members.cancel")}
            </Button>
            <Button
              variant="danger"
              type="button"
              disabled={busy}
              onClick={async () => {
                await run(api(`${base}/invites/${revoking!.id}`, "DELETE"));
                setRevoking(undefined);
              }}
            >
              {t("invites.revokeConfirm")}
            </Button>
          </>
        }
      >
        <p className="text-text-secondary">{t("invites.revokeBody")}</p>
      </Dialog>
    </div>
  );
}

function InviteForm({ base, onCreated }: { base: string; onCreated: () => void }) {
  const t = useTranslations("accounts");
  const tc = useTranslations("common");
  const [role, setRole] = useState<Role>("EDITOR");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ email: string; url: string }>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const email = String(new FormData(formEl).get("email"));
    setPending(true);
    setError(undefined);
    const res = await api<{ email: string; token: string }>(`${base}/invites`, "POST", { email, role });
    setPending(false);
    if (!res.ok) {
      setError(res.status === 409 ? t("invites.alreadyMember") : t("invites.failed"));
      return;
    }
    // The token goes in the fragment: never sent to a server, never in a Referer.
    setCreated({ email: res.data!.email, url: `${window.location.origin}/invite#token=${res.data!.token}` });
    formEl.reset();
    onCreated();
  }

  return (
    <div className="rounded-card border border-border bg-bg-surface p-4 shadow-e1">
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <Field label={t("invites.email")}>
            <Input name="email" type="email" required autoComplete="off" placeholder="name@example.com" />
          </Field>
        </div>
        <Field label={t("invites.role")}>
          <select name="role" className={selectClass} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {tc(`roles.${r}`)}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? t("invites.creating") : t("invites.create")}
        </Button>
      </form>
      <p className="mt-2 text-meta text-text-muted">{t(`roleHelp.${role}`)}</p>
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <Dialog
        open={Boolean(created)}
        title={created ? t("invites.linkTitle", { email: created.email }) : ""}
        onClose={() => setCreated(undefined)}
        footer={
          <Button type="button" onClick={() => setCreated(undefined)}>
            {t("invites.done")}
          </Button>
        }
      >
        {created && (
          <div className="flex flex-col gap-3">
            <p className="text-text-secondary">{t("invites.linkBody", { email: created.email })}</p>
            <LinkReveal url={created.url} copyLabel={t("invites.copy")} copiedLabel={t("invites.copied")} />
          </div>
        )}
      </Dialog>
    </div>
  );
}

