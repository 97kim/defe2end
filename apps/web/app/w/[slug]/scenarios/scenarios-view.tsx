"use client";

import type { RunStatus } from "@defe2end/shared";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Alert, Button, buttonClass, Chip, Dialog, Field, Input, inputClass, PageHeader, Tag, Toasts, useToasts } from "../../../../components/ui";
import { api } from "../../../../lib/api-client";
import { RECENT_RUNS, type ScenarioListRow } from "../../../../lib/scenario-list";
import { StatusBadge, STATUS_FILL } from "../runs/run-ui";
import { useHydrated } from "../runs/use-hydrated";
import { DownloadIcon, FileJsonIcon, ListChecksIcon, PlusIcon, RecordIcon, SearchIcon, UploadIcon, WriteIcon } from "./icons";
import { ImportDialog } from "./import-dialog";

export interface SiteOption {
  id: string;
  name: string;
  environments: { id: string; workspaceId: string; name: string; baseUrl: string; useAuthSession: boolean }[];
}

type Filter = { kind: "all" } | { kind: "archived" } | { kind: "failing" } | { kind: "tag"; name: string };

const FAILING = new Set(["failed", "error", "timed_out"]);

/** The list's current order (filter and search applied), for the detail page's previous / next links. */
export const ORDER_KEY = (slug: string) => `defe2end:scenarioOrder:${slug}`;

export function ScenariosView({
  slug,
  workspaceName,
  canWrite,
  scenarios,
  sites,
}: {
  slug: string;
  workspaceName: string;
  canWrite: boolean;
  scenarios: ScenarioListRow[];
  sites: SiteOption[];
}) {
  const tRuns = useTranslations("runs");
  const t = useTranslations("scenarios");
  const format = useFormatter();
  const hydrated = useHydrated();
  const router = useRouter();
  const { toasts, push, dismiss } = useToasts();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  const last = (s: ScenarioListRow) => s.recent.at(-1);
  const active = useMemo(() => scenarios.filter((s) => !s.archivedAt), [scenarios]);
  const archivedCount = scenarios.length - active.length;
  const failingCount = active.filter((s) => FAILING.has(last(s)?.status ?? "")).length;
  const usedTags = useMemo(() => [...new Set(active.flatMap((s) => s.tags.map((t) => t.name)))].sort(), [active]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = filter.kind === "archived" ? scenarios.filter((s) => s.archivedAt) : active;
    return base.filter(
      (s) =>
        (filter.kind !== "tag" || s.tags.some((tag) => tag.name === filter.name)) &&
        (filter.kind !== "failing" || FAILING.has(s.recent.at(-1)?.status ?? "")) &&
        (!q || s.name.toLowerCase().includes(q) || s.tags.some((tag) => tag.name.toLowerCase().includes(q))),
    );
  }, [scenarios, active, filter, query]);

  // Remember the visible order so the detail page can step to the previous / next scenario.
  useEffect(() => {
    try {
      window.sessionStorage.setItem(ORDER_KEY(slug), JSON.stringify(visible.map((s) => ({ id: s.id, name: s.name }))));
    } catch {
      // No storage: the detail page just hides previous / next.
    }
  }, [slug, visible]);

  const base = `/w/${slug}/scenarios`;
  const open = (id: string) => router.push(`${base}/${id}`);
  const failed = (message?: string) => push(t("toast.failed", { message: message ?? "" }), "error");
  const ago = (iso: string) => (hydrated ? format.relativeTime(new Date(iso)) : "");

  async function exportScenarios(ids?: string[]) {
    const res = await fetch(`/api/w/${slug}/scenarios/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ids ? { ids } : {}),
    });
    if (!res.ok) return failed((await res.json().catch(() => undefined))?.error?.message ?? res.statusText);
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "defe2end-scenarios.json";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const count = ids?.length ?? (JSON.parse(await blob.text()) as { scenarios: unknown[] }).scenarios.length;
    push(t("toast.exported", { count }));
  }

  const headerActions = (
    <>
      {canWrite && (
        <>
          <Button variant="secondary" onClick={() => setImporting(true)}>
            <UploadIcon />
            {t("import")}
          </Button>
          {scenarios.length > 0 && (
            <Button
              variant="secondary"
              disabled={visible.length === 0}
              title={t("exportVisible", { count: visible.length })}
              onClick={() => exportScenarios(filter.kind === "all" && !query ? undefined : visible.map((s) => s.id))}
            >
              <DownloadIcon />
              {t("export")}
            </Button>
          )}
        </>
      )}
      <Button variant={scenarios.length === 0 ? "secondary" : "primary"} disabled={!canWrite} onClick={() => setCreating(true)}>
        <PlusIcon />
        {t("newScenario")}
      </Button>
    </>
  );

  const dialogs = (
    <>
      {creating && (
        <CreateDialog
          slug={slug}
          sites={sites}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            push(t("toast.created"));
            open(id);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          slug={slug}
          onClose={() => setImporting(false)}
          onImported={(count) => {
            setImporting(false);
            push(t("importDialog.done", { count }));
            router.refresh();
          }}
        />
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );

  if (scenarios.length === 0) {
    return (
      <>
        <PageHeader crumbs={[workspaceName, t("title")]} title={t("title")} actions={headerActions} />
        <EmptyScenarios workspaceName={workspaceName} canWrite={canWrite} onWrite={() => setCreating(true)} onImport={() => setImporting(true)} />
        {dialogs}
      </>
    );
  }

  const th = "px-4 py-2 text-left text-label font-semibold uppercase tracking-wider text-text-muted";
  return (
    <>
      <PageHeader crumbs={[workspaceName, t("title")]} title={t("title")} actions={headerActions} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative block w-[320px]">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-muted" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("list.search", { count: active.length })} className={`${inputClass} pl-9`} />
          </label>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={filter.kind === "all"} onClick={() => setFilter({ kind: "all" })}>
              {t("list.all")} <span className="font-mono text-code">{active.length}</span>
            </Chip>
            <Chip active={filter.kind === "failing"} disabled={failingCount === 0} title={t("list.failingHint")} onClick={() => setFilter(filter.kind === "failing" ? { kind: "all" } : { kind: "failing" })}>
              {t("list.failing")} <span className="font-mono text-code">{failingCount}</span>
            </Chip>
            {usedTags.map((name) => (
              <Chip key={name} mono active={filter.kind === "tag" && filter.name === name} onClick={() => setFilter(filter.kind === "tag" && filter.name === name ? { kind: "all" } : { kind: "tag", name })}>
                {name}
              </Chip>
            ))}
            {archivedCount > 0 && (
              <Chip active={filter.kind === "archived"} onClick={() => setFilter(filter.kind === "archived" ? { kind: "all" } : { kind: "archived" })}>
                {t("list.archived")} <span className="font-mono text-code">{archivedCount}</span>
              </Chip>
            )}
          </div>
        </div>
        <section className="overflow-x-auto rounded-card border border-border bg-bg-surface shadow-e1" aria-label={t("title")}>
          <table className="w-full text-body">
            <thead className="border-b border-border bg-bg-subtle">
              <tr>
                <th className={th}>{t("list.name")}</th>
                <th className={th}>{t("list.lastRun")}</th>
                <th className={th}>{t("list.lastRunAt")}</th>
                <th className={th}>{t("list.tags")}</th>
                <th className={th}>{t("list.recent")}</th>
                <th className={th}>{t("list.updated")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => {
                const lastRun = last(s);
                return (
                  <tr key={s.id} onClick={() => open(s.id)} className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-accent-soft">
                    <td className="max-w-[360px] px-4 py-3">
                      <Link href={`${base}/${s.id}`} onClick={(e) => e.stopPropagation()} className="block truncate text-title-sm hover:underline">
                        {s.name}
                      </Link>
                      {s.summary && <span className="block truncate text-meta text-text-muted">{s.summary}</span>}
                    </td>
                    <td className="px-4 py-3">
                      {s.archivedAt ? (
                        <span className="rounded-full bg-cancelled-soft px-2 py-0.5 text-meta font-semibold text-cancelled">{t("list.archivedBadge")}</span>
                      ) : lastRun ? (
                        <StatusBadge status={lastRun.status} label={tRuns(`status.${lastRun.status}`)} />
                      ) : (
                        <span className="text-meta text-text-muted">{t("list.noRuns")}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-code whitespace-nowrap text-text-secondary">{lastRun ? ago(lastRun.queuedAt) : "—"}</td>
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap gap-1">
                        {s.tags.map((tag) => (
                          <Tag key={tag.id}>{tag.name}</Tag>
                        ))}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <RecentRuns runs={s.recent} label={(status) => tRuns(`status.${status}`)} />
                    </td>
                    <td className="px-4 py-3 text-meta whitespace-nowrap text-text-secondary">
                      {s.updatedByName ?? "—"} <span className="font-mono text-code text-text-muted">· {ago(s.updatedAt)}</span>
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-text-muted">
                    {t("list.noMatches")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <p className="text-meta text-text-muted">{t("list.showing", { shown: visible.length, total: filter.kind === "archived" ? archivedCount : active.length })}</p>
      </div>
      {dialogs}
    </>
  );
}

/** The last runs as small bars (oldest left), each with its status in the title; empty slots stay faint. */
export function RecentRuns({ runs, label }: { runs: ScenarioListRow["recent"]; label: (status: RunStatus) => string }) {
  return (
    <span className="flex h-4 items-end gap-0.5" aria-label={runs.map((r) => label(r.status)).join(", ") || undefined}>
      {Array.from({ length: RECENT_RUNS - runs.length }, (_, i) => (
        <span key={`e${i}`} className="h-4 w-1.5 rounded-[2px] bg-border/60" aria-hidden="true" />
      ))}
      {runs.map((r) => (
        <span key={r.id} title={label(r.status)} className={`h-4 w-1.5 rounded-[2px] ${STATUS_FILL[r.status]}`} />
      ))}
    </span>
  );
}

function CreateDialog({ slug, sites, onClose, onCreated }: { slug: string; sites: SiteOption[]; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations("scenarios.create");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    const res = await api<{ id: string }>(`/api/w/${slug}/scenarios`, "POST", { name: String(form.get("name")), siteId: String(form.get("siteId")) });
    setPending(false);
    if (!res.ok) return setError(res.error?.message);
    onCreated(res.data!.id);
  }

  if (sites.length === 0) {
    return (
      <Dialog
        title={t("title")}
        onClose={onClose}
        footer={
          <Link href={`/w/${slug}/settings`} className={buttonClass("primary")}>
            {t("openSettings")}
          </Link>
        }
      >
        <p className="text-text-secondary">{t("noSites")}</p>
      </Dialog>
    );
  }
  return (
    <Dialog
      title={t("title")}
      onClose={onClose}
      onSubmit={onSubmit}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={pending}>
            {t("submit")}
          </Button>
        </>
      }
    >
      <Field label={t("name")}>
        <Input name="name" required maxLength={200} autoFocus placeholder={t("namePlaceholder")} />
      </Field>
      <Field label={t("site")}>
        <select name="siteId" className={inputClass} defaultValue={sites[0]!.id}>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      {error && <Alert>{error}</Alert>}
    </Dialog>
  );
}

function EmptyScenarios({ workspaceName, canWrite, onWrite, onImport }: { workspaceName: string; canWrite: boolean; onWrite: () => void; onImport: () => void }) {
  const t = useTranslations("scenarios.empty");
  const cards = [
    { n: "01", icon: <RecordIcon width={18} height={18} />, title: t("recordTitle"), body: t("recordBody"), action: t("recordAction"), onClick: undefined, badge: t("comingLater") },
    { n: "02", icon: <WriteIcon width={18} height={18} />, title: t("writeTitle"), body: t("writeBody"), action: t("writeAction"), onClick: onWrite, plus: true },
    { n: "03", icon: <FileJsonIcon width={18} height={18} />, title: t("importTitle"), body: t("importBody"), action: t("importAction"), onClick: onImport },
  ];
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-8 py-16">
      <span className="flex size-12 items-center justify-center rounded-card border border-border bg-bg-surface shadow-e1">
        <ListChecksIcon width={22} height={22} />
      </span>
      <h2 className="mt-6 text-display">{t("title")}</h2>
      <p className="mt-3 max-w-[620px] text-center text-[15px] leading-relaxed text-text-secondary">{t("body", { workspace: workspaceName })}</p>
      {canWrite ? (
        <div className="mt-10 grid w-full max-w-[920px] grid-cols-3 gap-4">
          {cards.map((c) => (
            <div key={c.n} className={`flex flex-col gap-2 rounded-card border border-border bg-bg-surface p-5 shadow-e1 ${c.onClick ? "" : "opacity-70"}`}>
              <div className="flex items-center justify-between">
                <span className="flex size-9 items-center justify-center rounded-control bg-bg-subtle">{c.icon}</span>
                <span className="flex items-center gap-2">
                  {c.badge && <span className="rounded-tag bg-accent-soft px-1.5 py-0.5 text-meta font-semibold text-text-secondary">{c.badge}</span>}
                  <span className="font-mono text-code text-text-muted">{c.n}</span>
                </span>
              </div>
              <h3 className="mt-2 text-title-sm">{c.title}</h3>
              <p className="flex-1 text-text-secondary">{c.body}</p>
              <div className="mt-3">
                <Button variant="secondary" disabled={!c.onClick} onClick={c.onClick}>
                  {c.plus ? <PlusIcon /> : c.n === "03" ? <UploadIcon /> : null}
                  {c.action}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-8 text-text-muted">{t("viewerBody")}</p>
      )}
    </div>
  );
}
