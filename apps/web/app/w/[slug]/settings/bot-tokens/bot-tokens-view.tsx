"use client";

import { BOT_TOKEN_SCOPES, BOT_TOKEN_TTL_DAYS } from "@defe2end/shared";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Chip, Dialog, EmptyState, Field, Input, Toasts, useToasts } from "../../../../../components/ui";
import type { BotDetail, BotTokenView } from "../../../../../lib/bot-tokens";
import { useHydrated } from "../../runs/use-hydrated";

export function BotTokensView({ slug, tokens, canWrite }: { slug: string; tokens: BotTokenView[]; canWrite: boolean }) {
  const t = useTranslations("settings.botTokens");
  const format = useFormatter();
  const hydrated = useHydrated();
  const router = useRouter();
  const { toasts, push, dismiss } = useToasts();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", scopes: [...BOT_TOKEN_SCOPES] as string[], days: String(BOT_TOKEN_TTL_DAYS.default) });
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<BotTokenView | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const when = (iso: string | null) => (iso && hydrated ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : iso ? "" : t("never"));

  async function create() {
    setBusy(true);
    const res = await fetch(`/api/w/${slug}/bot-tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: form.name, scopes: form.scopes, expiresInDays: Number(form.days) }) });
    const body = await res.json().catch(() => undefined);
    setBusy(false);
    if (!res.ok) return push(body?.error?.message ?? t("errorGeneric"), "error");
    setCreating(false);
    setForm({ name: "", scopes: [...BOT_TOKEN_SCOPES], days: String(BOT_TOKEN_TTL_DAYS.default) });
    setCopied(false);
    setCreated(body.token);
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    const res = await fetch(`/api/w/${slug}/bot-tokens/${revoking.id}`, { method: "DELETE" });
    setBusy(false);
    setRevoking(null);
    if (!res.ok) return push(t("errorGeneric"), "error");
    router.refresh();
  }

  function closeCreated() {
    // The raw token is gone for good once this closes.
    setCreated(null);
    router.refresh();
  }

  const state = (token: BotTokenView) => (token.revokedAt ? "revoked" : hydrated && new Date(token.expiresAt).getTime() <= Date.now() ? "expired" : "active");

  return (
    <div className="flex max-w-[1080px] flex-col gap-4">
      <p className="max-w-[640px] text-text-secondary">{t("intro")}</p>
      {canWrite ? (
        <div>
          <Button onClick={() => setCreating(true)}>{t("create")}</Button>
        </div>
      ) : (
        <p className="text-meta text-text-muted">{t("viewerHint")}</p>
      )}
      {tokens.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <section className="overflow-x-auto rounded-card border border-border bg-bg-surface shadow-e1">
          <table className="w-full text-left text-body">
            <thead className="border-b border-border bg-bg-subtle text-meta text-text-secondary">
              <tr>
                <th className="px-4 py-2 font-semibold">{t("name")}</th>
                <th className="px-4 py-2 font-semibold">{t("prefix")}</th>
                <th className="px-4 py-2 font-semibold">{t("scopes")}</th>
                <th className="px-4 py-2 font-semibold">{t("expiresAt")}</th>
                <th className="px-4 py-2 font-semibold">{t("lastUsedAt")}</th>
                <th className="px-4 py-2 font-semibold">{t("createdBy")}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => {
                const s = state(token);
                const tone = s === "active" ? "text-pass" : s === "expired" ? "text-warn" : "text-text-muted";
                return (
                  <TokenRows key={token.id} slug={slug} token={token} canWrite={canWrite} expanded={open === token.id} onToggle={() => setOpen(open === token.id ? null : token.id)} push={push}>
                    <td className="px-4 py-3">
                      <span className="font-semibold">{token.name}</span>
                      <span className={`block text-meta font-semibold ${tone}`}>{t(s)}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-code">{token.prefix}…</td>
                    <td className="px-4 py-3 font-mono text-code text-text-secondary">{token.scopes.join(" ")}</td>
                    <td className="px-4 py-3 font-mono text-code text-text-secondary">{when(token.expiresAt)}</td>
                    <td className="px-4 py-3 font-mono text-code text-text-secondary">{when(token.lastUsedAt)}</td>
                    <td className="px-4 py-3 text-text-secondary">{token.createdByName ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className="flex justify-end gap-2">
                        <Button variant="secondary" onClick={() => setOpen(open === token.id ? null : token.id)}>
                          {open === token.id ? t("hide") : t("manage")}
                        </Button>
                        {canWrite && !token.revokedAt && (
                          <Button variant="secondary" disabled={busy} onClick={() => setRevoking(token)}>
                            {t("revoke")}
                          </Button>
                        )}
                      </span>
                    </td>
                  </TokenRows>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {creating && (
        <Dialog
          title={t("create")}
          onClose={() => !busy && setCreating(false)}
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          footer={
            <>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setCreating(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={busy || !form.name.trim() || form.scopes.length === 0}>
                {t("create")}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <Field label={t("name")}>
              <Input autoFocus value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label={t("scopes")}>
              <span className="flex flex-wrap gap-2">
                {BOT_TOKEN_SCOPES.map((scope) => (
                  <Chip key={scope} mono active={form.scopes.includes(scope)} onClick={() => setForm({ ...form, scopes: form.scopes.includes(scope) ? form.scopes.filter((s) => s !== scope) : [...form.scopes, scope] })}>
                    {scope}
                  </Chip>
                ))}
              </span>
            </Field>
            <Field label={t("expiresInDays")} hint={t("expiresHint")}>
              <Input type="number" min={1} max={BOT_TOKEN_TTL_DAYS.max} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
            </Field>
          </div>
        </Dialog>
      )}

      {created && (
        <Dialog title={t("createdTitle")} onClose={closeCreated} footer={<Button onClick={closeCreated}>{t("done")}</Button>}>
          <p className="mb-3 text-text-secondary">{t("createdBody")}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-card border border-border bg-bg-subtle px-3 py-2 font-mono text-code">{created}</code>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(created).then(() => setCopied(true));
              }}
            >
              {copied ? t("copied") : t("copy")}
            </Button>
          </div>
        </Dialog>
      )}

      {revoking && (
        <Dialog
          title={t("revokeTitle")}
          onClose={() => !busy && setRevoking(null)}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setRevoking(null)}>
                {t("keep")}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void revoke()}>
                {t("revoke")}
              </Button>
            </>
          }
        >
          <p className="text-text-secondary">{t("revokeBody", { name: revoking.name })}</p>
        </Dialog>
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

type Push = (message: string, tone?: "error") => void;

/** A token row, and below it (when open) the bot's own values and login sessions. */
function TokenRows({ slug, token, canWrite, expanded, onToggle, push, children }: { slug: string; token: BotTokenView; canWrite: boolean; expanded: boolean; onToggle: () => void; push: Push; children: ReactNode }) {
  return (
    <>
      <tr className="border-b border-border last:border-b-0" onDoubleClick={onToggle}>
        {children}
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-bg-subtle">
          <td colSpan={7} className="px-4 py-4">
            <BotDetailPanel slug={slug} tokenId={token.id} canWrite={canWrite && !token.revokedAt} push={push} />
          </td>
        </tr>
      )}
    </>
  );
}

function BotDetailPanel({ slug, tokenId, canWrite, push }: { slug: string; tokenId: string; canWrite: boolean; push: Push }) {
  const t = useTranslations("settings.botTokens");
  const [detail, setDetail] = useState<BotDetail | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  async function load() {
    const res = await fetch(`/api/w/${slug}/bot-tokens/${tokenId}`);
    if (!res.ok) return push(t("errorGeneric"), "error");
    setDetail(await res.json());
  }
  // Once per token: `push` is a new function every render.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, tokenId]);
  if (!detail) return null;

  async function save(variableId: string, value: string | null) {
    const res = await fetch(`/api/w/${slug}/bot-tokens/${tokenId}/values/${variableId}`, value === null ? { method: "DELETE" } : { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
    if (!res.ok) return push((await res.json().catch(() => undefined))?.error?.message ?? t("errorGeneric"), "error");
    setDrafts((d) => ({ ...d, [variableId]: "" }));
    await load();
  }

  async function capture(environmentId: string) {
    const res = await fetch(`/api/w/${slug}/environments/${environmentId}/auth-session/capture`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: { kind: "bot", botTokenId: tokenId } }) });
    if (res.ok) return push(t("captureSent"));
    const code = (await res.json().catch(() => undefined))?.error?.code;
    push(code === "desktop_not_connected" ? t("errorDesktop") : code === "app_update_required" ? t("errorUpdate") : t("errorGeneric"), "error");
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="flex flex-col gap-2">
        <h3 className="font-semibold">{t("values")}</h3>
        <p className="text-meta text-text-muted">{t("valuesHint")}</p>
        {detail.values.length === 0 && <p className="text-text-secondary">{t("noValues")}</p>}
        {detail.values.map((v) => (
          <div key={v.variableId} className="flex flex-wrap items-center gap-2">
            <span className="min-w-[160px] font-mono text-code">
              {v.key} <span className="text-text-muted">· {v.siteName} / {v.environmentName}</span>
            </span>
            <span className={`text-meta ${v.hasValue ? "text-pass" : "text-text-muted"}`}>{v.hasValue ? (v.isSecret ? t("secretSet") : v.value) : t("notSet")}</span>
            {canWrite && (
              <>
                <Input className="w-40" type={v.isSecret ? "password" : "text"} autoComplete="off" value={drafts[v.variableId] ?? ""} onChange={(e) => setDrafts({ ...drafts, [v.variableId]: e.target.value })} />
                <Button variant="secondary" disabled={!(drafts[v.variableId] ?? "")} onClick={() => void save(v.variableId, drafts[v.variableId]!)}>
                  {t("save")}
                </Button>
                {v.hasValue && (
                  <Button variant="secondary" onClick={() => void save(v.variableId, null)}>
                    {t("clear")}
                  </Button>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="font-semibold">{t("sessions")}</h3>
        {detail.sessions.length === 0 && <p className="text-text-secondary">{t("noSessions")}</p>}
        {detail.sessions.map((s) => {
          const state = !s.expiresAt ? "sessionMissing" : new Date(s.expiresAt).getTime() <= Date.now() ? "sessionExpired" : "sessionValid";
          const tone = state === "sessionValid" ? "text-pass" : state === "sessionExpired" ? "text-warn" : "text-text-muted";
          return (
            <div key={s.environmentId} className="flex items-center gap-3">
              <span className="min-w-[160px]">
                {s.siteName} <span className="text-text-secondary">/ {s.environmentName}</span>
              </span>
              <span className={`text-meta font-semibold ${tone}`}>{t(state)}</span>
              {canWrite && (
                <Button variant="secondary" onClick={() => void capture(s.environmentId)}>
                  {t("captureSession")}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
