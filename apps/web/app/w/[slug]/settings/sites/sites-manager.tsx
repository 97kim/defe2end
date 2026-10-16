"use client";

import { SECRET_MASK } from "@defe2end/shared";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Dialog, EmptyState, Field, Input, Toggle } from "../../../../../components/ui";
import { api } from "../../../../../lib/api-client";

interface VariableData {
  id: string;
  key: string;
  isSecret: boolean;
  scope: "shared" | "personal";
  value: string | null;
  hasValue: boolean;
  /** Personal variables: the caller's own value only. */
  mine?: { hasValue: boolean; value?: string };
}
interface EnvironmentData {
  id: string;
  siteId: string;
  name: string;
  baseUrl: string;
  useAuthSession: boolean;
  variables: VariableData[];
}
interface SiteData {
  id: string;
  name: string;
  environments: EnvironmentData[];
}

type DialogState =
  | { kind: "site"; site?: SiteData }
  | { kind: "deleteSite"; site: SiteData }
  | { kind: "environment"; site: SiteData; environment?: EnvironmentData }
  | { kind: "deleteEnvironment"; environment: EnvironmentData }
  | { kind: "variable"; variable: VariableData; replaceOnly: boolean }
  | { kind: "deleteVariable"; variable: VariableData }
  | { kind: "myValue"; variable: VariableData };

// Same rules as lib/site-config.ts, checked here for a localized message before the round trip.
const KEY_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function SitesManager({ slug, sites, canWrite, canWriteMine = false }: { slug: string; sites: SiteData[]; canWrite: boolean; canWriteMine?: boolean }) {
  const t = useTranslations("settings");
  const [dialog, setDialog] = useState<DialogState>();
  const [open, setOpen] = useState<Set<string>>(() => new Set(sites.flatMap((s) => s.environments.slice(0, 1).map((e) => e.id))));
  const close = () => setDialog(undefined);

  function toggleEnvironment(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <div className="flex items-end justify-between gap-6">
        <div>
          <h2 className="text-title-md">{t("sites.heading")}</h2>
          <p className="max-w-[640px] text-text-muted">{t("sites.description")}</p>
        </div>
        {canWrite && <Button onClick={() => setDialog({ kind: "site" })}>{t("sites.newSite")}</Button>}
      </div>

      {sites.length === 0 ? (
        <EmptyState title={t("sites.empty")} body={canWrite ? t("sites.emptyBody") : t("sites.emptyViewer")} />
      ) : (
        sites.map((site) => (
          <section key={site.id} className="overflow-hidden rounded-card border border-border bg-bg-surface shadow-e1">
            <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h3 className="truncate text-title-sm">{site.name}</h3>
                <p className="text-meta text-text-muted">{t("sites.environmentCount", { count: site.environments.length })}</p>
              </div>
              {canWrite && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="secondary" onClick={() => setDialog({ kind: "environment", site })}>
                    {t("environments.add")}
                  </Button>
                  <Button variant="ghost" onClick={() => setDialog({ kind: "site", site })}>
                    {t("actions.rename")}
                  </Button>
                  <Button variant="ghost" onClick={() => setDialog({ kind: "deleteSite", site })}>
                    {t("actions.delete")}
                  </Button>
                </div>
              )}
            </header>

            {site.environments.length === 0 ? (
              <p className="px-5 py-4 text-text-muted">{t("environments.noEnvironments")}</p>
            ) : (
              <ul className="divide-y divide-border">
                {site.environments.map((env) => {
                  const expanded = open.has(env.id);
                  return (
                    <li key={env.id}>
                      <div className={`flex items-center gap-4 px-5 py-3 ${expanded ? "bg-bg-subtle" : ""}`}>
                        <button
                          type="button"
                          onClick={() => toggleEnvironment(env.id)}
                          aria-expanded={expanded}
                          aria-label={expanded ? t("environments.hideVariables") : t("environments.showVariables")}
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        >
                          <Chevron open={expanded} />
                          <span className="w-40 shrink-0 truncate font-semibold">{env.name}</span>
                          <span className="min-w-0 flex-1 truncate font-mono text-code text-text-secondary">{env.baseUrl}</span>
                          {env.useAuthSession && <span className="shrink-0 rounded-full border border-border px-2 text-meta text-text-secondary">{t("environments.authSessionBadge")}</span>}
                          <span className="shrink-0 text-meta text-text-muted">
                            {t("environments.variables")} · {env.variables.length}
                          </span>
                        </button>
                        {canWrite && (
                          <div className="flex shrink-0 gap-1">
                            <Button variant="ghost" onClick={() => setDialog({ kind: "environment", site, environment: env })}>
                              {t("actions.edit")}
                            </Button>
                            <Button variant="ghost" onClick={() => setDialog({ kind: "deleteEnvironment", environment: env })}>
                              {t("actions.delete")}
                            </Button>
                          </div>
                        )}
                      </div>
                      {expanded && <VariablesPanel slug={slug} environment={env} canWrite={canWrite} canWriteMine={canWriteMine} onDialog={setDialog} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))
      )}

      {dialog?.kind === "site" && <SiteDialog slug={slug} site={dialog.site} onClose={close} />}
      {dialog?.kind === "deleteSite" && (
        <ConfirmDelete
          title={t("sites.deleteSiteTitle", { name: dialog.site.name })}
          body={t("sites.deleteSiteBody")}
          confirm={t("sites.deleteSiteConfirm")}
          url={`/api/w/${slug}/sites/${dialog.site.id}`}
          conflictMessage={t("sites.siteInUse")}
          onClose={close}
        />
      )}
      {dialog?.kind === "environment" && <EnvironmentDialog slug={slug} site={dialog.site} environment={dialog.environment} onClose={close} />}
      {dialog?.kind === "deleteEnvironment" && (
        <ConfirmDelete
          title={t("environments.deleteTitle", { name: dialog.environment.name })}
          body={t("environments.deleteBody")}
          confirm={t("environments.deleteConfirm")}
          url={`/api/w/${slug}/environments/${dialog.environment.id}`}
          onClose={close}
        />
      )}
      {dialog?.kind === "myValue" && <MyValueDialog slug={slug} variable={dialog.variable} onClose={close} />}
      {dialog?.kind === "variable" && <VariableDialog slug={slug} variable={dialog.variable} replaceOnly={dialog.replaceOnly} onClose={close} />}
      {dialog?.kind === "deleteVariable" && (
        <ConfirmDelete
          title={t("variables.deleteTitle", { key: dialog.variable.key })}
          body={t("variables.deleteBody")}
          confirm={t("variables.deleteConfirm")}
          url={`/api/w/${slug}/variables/${dialog.variable.id}`}
          onClose={close}
        />
      )}
    </>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-90" : ""}`}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** Submit state shared by the dialogs: pending flag, localized error, refresh on success. */
function useSubmit(onDone: () => void) {
  const t = useTranslations("settings");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function run(url: string, method: string, body: unknown, conflictMessage?: string): Promise<boolean> {
    setPending(true);
    setError(undefined);
    const res = await api(url, method, body);
    setPending(false);
    if (!res.ok) {
      setError(
        res.error?.code === "conflict" && conflictMessage
          ? conflictMessage
          : res.error?.code === "forbidden"
            ? t("errors.forbidden")
            : res.error?.code === "not_found"
              ? t("errors.notFound")
              : t("errors.generic"),
      );
      return false;
    }
    router.refresh();
    onDone();
    return true;
  }
  return { pending, error, setError, run };
}

function DialogFooter({ onCancel, submitLabel, pending, danger }: { onCancel: () => void; submitLabel: string; pending: boolean; danger?: boolean }) {
  const t = useTranslations("settings");
  return (
    <>
      <Button type="button" variant="secondary" onClick={onCancel}>
        {t("actions.cancel")}
      </Button>
      <Button type="submit" variant={danger ? "danger" : "primary"} disabled={pending}>
        {pending ? t("actions.saving") : submitLabel}
      </Button>
    </>
  );
}

function SiteDialog({ slug, site, onClose }: { slug: string; site?: SiteData; onClose: () => void }) {
  const t = useTranslations("settings");
  const [name, setName] = useState(site?.name ?? "");
  const { pending, error, run } = useSubmit(onClose);
  const submit = () =>
    void run(site ? `/api/w/${slug}/sites/${site.id}` : `/api/w/${slug}/sites`, site ? "PATCH" : "POST", { name }, t("sites.siteConflict"));
  const label = site ? t("actions.save") : t("sites.createSite");
  return (
    <Dialog open title={site ? t("sites.renameSite") : t("sites.newSite")} onClose={onClose} onSubmit={submit} footer={<DialogFooter onCancel={onClose} submitLabel={label} pending={pending} />}>
      <Field label={t("sites.siteName")}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("sites.siteNamePlaceholder")} maxLength={100} required autoFocus />
      </Field>
      {error && <Alert>{error}</Alert>}
    </Dialog>
  );
}

function EnvironmentDialog({ slug, site, environment, onClose }: { slug: string; site: SiteData; environment?: EnvironmentData; onClose: () => void }) {
  const t = useTranslations("settings");
  const [name, setName] = useState(environment?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(environment?.baseUrl ?? "https://");
  const [useAuthSession, setUseAuthSession] = useState(environment?.useAuthSession ?? false);
  const [urlError, setUrlError] = useState<string>();
  const { pending, error, run } = useSubmit(onClose);

  function submit() {
    if (!isValidBaseUrl(baseUrl)) return setUrlError(t("environments.baseUrlInvalid"));
    setUrlError(undefined);
    const url = environment ? `/api/w/${slug}/environments/${environment.id}` : `/api/w/${slug}/sites/${site.id}/environments`;
    void run(url, environment ? "PATCH" : "POST", { name, baseUrl, useAuthSession }, t("environments.conflict"));
  }

  return (
    <Dialog
      open
      title={environment ? t("environments.editTitle") : t("environments.newTitle", { site: site.name })}
     
      onClose={onClose}
      onSubmit={submit}
      footer={<DialogFooter onCancel={onClose} submitLabel={environment ? t("actions.save") : t("environments.add")} pending={pending} />}
    >
      <Field label={t("environments.name")}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("environments.namePlaceholder")} maxLength={100} required autoFocus />
      </Field>
      <Field label={t("environments.baseUrl")} hint={t("environments.baseUrlHint")} error={urlError}>
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://staging.example.com" className="font-mono" required aria-invalid={Boolean(urlError)} />
      </Field>
      <div className="flex flex-col gap-1">
        <Toggle checked={useAuthSession} onChange={setUseAuthSession} label={t("environments.useAuthSession")} />
        <p className="text-meta text-text-muted">{t("environments.useAuthSessionHint")}</p>
      </div>
      {error && <Alert>{error}</Alert>}
    </Dialog>
  );
}

function ConfirmDelete({ title, body, confirm, url, conflictMessage, onClose }: { title: string; body: string; confirm: string; url: string; conflictMessage?: string; onClose: () => void }) {
  const t = useTranslations("settings");
  const { pending, error, run } = useSubmit(onClose);
  return (
    <Dialog open title={title} onClose={onClose} onSubmit={() => void run(url, "DELETE", undefined, conflictMessage)} footer={<DialogFooter onCancel={onClose} submitLabel={confirm} pending={pending} danger />}>
      <p className="text-text-secondary">{body}</p>
      {error && <Alert>{error}</Alert>}
    </Dialog>
  );
}

function VariablesPanel({ slug, environment, canWrite, canWriteMine, onDialog }: { slug: string; environment: EnvironmentData; canWrite: boolean; canWriteMine: boolean; onDialog: (d: DialogState) => void }) {
  const t = useTranslations("settings");
  const router = useRouter();
  const clearMine = async (v: VariableData) => {
    const res = await fetch(`/api/w/${slug}/variables/${v.id}/mine`, { method: "DELETE" });
    if (res.ok) router.refresh();
  };
  const hasActions = canWrite || (canWriteMine && environment.variables.some((v) => v.scope === "personal"));
  return (
    <div className="border-t border-border bg-bg-subtle px-5 pb-5 pt-3">
      <p className="mb-3 text-meta text-text-muted">
        {t("variables.description", { example: "{{KEY}}" })}
      </p>
      <div className="overflow-hidden rounded-item border border-border bg-bg-surface">
        <table className="w-full table-fixed text-left">
          <thead>
            <tr className="border-b border-border text-label uppercase tracking-wider text-text-muted">
              <th className="w-[28%] px-4 py-2">{t("variables.key")}</th>
              <th className="w-[96px] px-4 py-2">{t("variables.scope")}</th>
              <th className="px-4 py-2">{t("variables.value")}</th>
              {hasActions && <th className="w-[300px] px-4 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {environment.variables.length === 0 && (
              <tr>
                <td colSpan={hasActions ? 4 : 3} className="px-4 py-3 text-text-muted">
                  {t("variables.empty")}
                </td>
              </tr>
            )}
            {environment.variables.map((v) => (
              <tr key={v.id}>
                <td className="truncate px-4 py-2.5 font-mono text-code">{v.key}</td>
                <td className="px-4 py-2.5">
                  <span className={`rounded-tag border px-1.5 py-0.5 text-meta font-semibold ${v.scope === "personal" ? "border-accent-border bg-accent-soft text-text-primary" : "border-border text-text-secondary"}`}>
                    {v.scope === "personal" ? t("variables.scopePersonal") : t("variables.scopeShared")}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="flex min-w-0 items-center gap-2">
                    {v.scope === "personal" ? (
                      <>
                        <span className="text-meta font-semibold text-text-secondary">{t("variables.myValue")}</span>
                        {v.isSecret && <span className="rounded-tag border border-border bg-bg-subtle px-1.5 py-0.5 text-meta font-semibold text-text-secondary">{t("variables.secretBadge")}</span>}
                        {!v.mine?.hasValue ? (
                          <span className="text-meta text-warn">{t("variables.myValueMissing")}</span>
                        ) : v.isSecret ? (
                          <span className="font-mono text-code tracking-widest text-text-muted" aria-label={t("variables.maskedLabel")}>
                            {SECRET_MASK}
                          </span>
                        ) : (
                          <span className="truncate font-mono text-code">{v.mine.value}</span>
                        )}
                      </>
                    ) : v.isSecret ? (
                      <>
                        <span className="rounded-tag border border-border bg-bg-subtle px-1.5 py-0.5 text-meta font-semibold text-text-secondary">{t("variables.secretBadge")}</span>
                        {v.hasValue ? (
                          <span className="font-mono text-code tracking-widest text-text-muted" aria-label={t("variables.maskedLabel")}>
                            {SECRET_MASK}
                          </span>
                        ) : (
                          <span className="text-meta text-warn">{t("variables.needsValue")}</span>
                        )}
                      </>
                    ) : (
                      <span className="truncate font-mono text-code">{v.value}</span>
                    )}
                  </span>
                </td>
                {hasActions && (
                  <td className="whitespace-nowrap px-2 py-1.5 text-right">
                    {v.scope === "personal" && canWriteMine && (
                      <>
                        <Button variant="ghost" onClick={() => onDialog({ kind: "myValue", variable: v })}>
                          {v.mine?.hasValue ? t("variables.changeMine") : t("variables.setMine")}
                        </Button>
                        {v.mine?.hasValue && (
                          <Button variant="ghost" onClick={() => void clearMine(v)}>
                            {t("variables.clearMine")}
                          </Button>
                        )}
                      </>
                    )}
                    {canWrite && v.scope === "shared" && v.isSecret && (
                      <Button variant="ghost" onClick={() => onDialog({ kind: "variable", variable: v, replaceOnly: true })}>
                        {t("variables.replaceValue")}
                      </Button>
                    )}
                    {canWrite && (
                      <>
                        <Button variant="ghost" onClick={() => onDialog({ kind: "variable", variable: v, replaceOnly: false })}>
                          {t("actions.edit")}
                        </Button>
                        <Button variant="ghost" onClick={() => onDialog({ kind: "deleteVariable", variable: v })}>
                          {t("actions.delete")}
                        </Button>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {canWrite && <AddVariable slug={slug} environmentId={environment.id} />}
      </div>
    </div>
  );
}

function AddVariable({ slug, environmentId }: { slug: string; environmentId: string }) {
  const t = useTranslations("settings");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [isSecret, setIsSecret] = useState(false);
  const [scope, setScope] = useState<"shared" | "personal">("shared");
  const { pending, error, setError, run } = useSubmit(() => {
    setKey("");
    setValue("");
    setIsSecret(false);
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!KEY_PATTERN.test(key.trim())) return setError(t("variables.keyInvalid"));
    if (scope === "shared" && isSecret && value.length === 0) return setError(t("variables.secretValueRequired"));
    void run(`/api/w/${slug}/environments/${environmentId}/variables`, "POST", { key: key.trim(), value: scope === "shared" ? value : "", isSecret, scope }, t("variables.conflict"));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border p-3">
      <div className="flex items-center gap-2">
        <div className="w-[34%] shrink-0">
          <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="KEY" aria-label={t("variables.key")} className="font-mono" maxLength={64} />
        </div>
        <select value={scope} onChange={(e) => setScope(e.target.value as "shared" | "personal")} aria-label={t("variables.scope")} className="h-9 shrink-0 rounded-control border border-border-strong bg-bg-surface px-2 text-body">
          <option value="shared">{t("variables.scopeShared")}</option>
          <option value="personal">{t("variables.scopePersonal")}</option>
        </select>
        <div className="min-w-0 flex-1">
          {scope === "personal" ? (
            <p className="text-meta text-text-muted">{t("variables.personalHint")}</p>
          ) : (
          <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type={isSecret ? "password" : "text"}
          autoComplete={isSecret ? "new-password" : "off"}
          placeholder={t("variables.value")}
          aria-label={t("variables.value")}
          className="font-mono"
          />
          )}
        </div>
        <Toggle checked={isSecret} onChange={setIsSecret} label={t("variables.secret")} />
        <Button type="submit" variant="secondary" className="shrink-0" disabled={pending || key.trim() === ""}>
          {t("variables.add")}
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </form>
  );
}

function VariableDialog({ slug, variable, replaceOnly, onClose }: { slug: string; variable: VariableData; replaceOnly: boolean; onClose: () => void }) {
  const t = useTranslations("settings");
  const [key, setKey] = useState(variable.key);
  const [isSecret, setIsSecret] = useState(variable.isSecret);
  const [scope, setScope] = useState(variable.scope);
  const personal = scope === "personal";
  // Scope or secret flag changes drop values (variables contract section 1): say so before saving.
  const dropsValues = scope !== variable.scope || (variable.scope === "personal" && isSecret !== variable.isSecret);
  // A secret's value is never sent to the browser, so its field starts empty.
  const [value, setValue] = useState(variable.isSecret ? "" : (variable.value ?? ""));
  const { pending, error, setError, run } = useSubmit(onClose);
  const valueRequired = !personal && (replaceOnly || (variable.scope === "shared" && variable.isSecret && !isSecret));

  function submit() {
    if (!KEY_PATTERN.test(key.trim())) return setError(t("variables.keyInvalid"));
    if (valueRequired && value.length === 0) return setError(t("variables.secretValueRequired"));
    const body: { key?: string; isSecret?: boolean; value?: string; scope?: "shared" | "personal" } = replaceOnly ? { value } : { key: key.trim(), isSecret, scope };
    // Empty secret field = keep the stored value. Personal variables have no shared value.
    if (!replaceOnly && !personal && (!isSecret || value.length > 0)) body.value = value;
    void run(`/api/w/${slug}/variables/${variable.id}`, "PATCH", body, t("variables.conflict"));
  }

  const hint = isSecret ? (variable.isSecret && !replaceOnly ? t("variables.keepValueHint") : t("variables.secretHint")) : variable.isSecret ? t("variables.unsecretHint") : undefined;

  return (
    <Dialog
      open
      title={replaceOnly ? t("variables.replaceTitle", { key: variable.key }) : t("variables.editTitle")}
     
      onClose={onClose}
      onSubmit={submit}
      footer={<DialogFooter onCancel={onClose} submitLabel={t("actions.save")} pending={pending} />}
    >
      {replaceOnly ? (
        <p className="text-text-secondary">{t("variables.replaceBody")}</p>
      ) : (
        <>
          <Field label={t("variables.key")}>
            <Input value={key} onChange={(e) => setKey(e.target.value)} className="font-mono" maxLength={64} required autoFocus />
          </Field>
          <Toggle checked={isSecret} onChange={setIsSecret} label={t("variables.secret")} />
          <Field label={t("variables.scope")}>
            <select value={scope} onChange={(e) => setScope(e.target.value as "shared" | "personal")} className="h-9 rounded-control border border-border-strong bg-bg-surface px-2 text-body">
              <option value="shared">{t("variables.scopeShared")}</option>
              <option value="personal">{t("variables.scopePersonal")}</option>
            </select>
          </Field>
          {dropsValues && <Alert>{scope !== variable.scope ? (personal ? t("variables.toPersonalWarning") : t("variables.toSharedWarning")) : t("variables.secretChangeWarning")}</Alert>}
        </>
      )}
      {!personal && (
      <Field label={replaceOnly || variable.isSecret ? t("variables.newValue") : t("variables.value")} hint={hint}>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type={isSecret ? "password" : "text"}
          autoComplete={isSecret ? "new-password" : "off"}
          placeholder={isSecret && !valueRequired ? SECRET_MASK : undefined}
          className="font-mono"
          required={valueRequired}
          autoFocus={replaceOnly}
        />
      </Field>
      )}
      {error && <Alert>{error}</Alert>}
    </Dialog>
  );
}

/** The caller's own value of a personal variable (secret ones are write-only, like shared secrets). */
function MyValueDialog({ slug, variable, onClose }: { slug: string; variable: VariableData; onClose: () => void }) {
  const t = useTranslations("settings");
  const [value, setValue] = useState(variable.isSecret ? "" : (variable.mine?.value ?? ""));
  const { pending, error, setError, run } = useSubmit(onClose);
  function submit() {
    if (variable.isSecret && value.length === 0) return setError(t("variables.secretValueRequired"));
    void run(`/api/w/${slug}/variables/${variable.id}/mine`, "PUT", { value });
  }
  return (
    <Dialog open title={t("variables.myValueTitle", { key: variable.key })} onClose={onClose} onSubmit={submit} footer={<DialogFooter onCancel={onClose} submitLabel={t("actions.save")} pending={pending} />}>
      <p className="text-text-secondary">{t("variables.myValueBody")}</p>
      <Field label={t("variables.myValue")}>
        <Input value={value} onChange={(e) => setValue(e.target.value)} type={variable.isSecret ? "password" : "text"} autoComplete={variable.isSecret ? "new-password" : "off"} className="font-mono" autoFocus />
      </Field>
      {error && <Alert>{error}</Alert>}
    </Dialog>
  );
}
