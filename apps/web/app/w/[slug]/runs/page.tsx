import { RUN_STATUSES, RUN_TRIGGERS } from "@defe2end/shared";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { buttonClass, EmptyState, inputClass, PageHeader } from "../../../../components/ui";
import { getDb } from "../../../../lib/db";
import { canInWorkspace, requireWorkspace } from "../../../../lib/page";
import { WRITE_ENDPOINTS } from "../../../../lib/run-endpoints";
import { listRuns, listRunsQuerySchema, LIST_QUERY_KEYS, type ListRunsQuery } from "../../../../lib/run-read";
import { RefreshWhileActive, StopAllButton } from "./runs-live";
import { formatDuration, shortRunId, StatusBadge } from "./run-ui";

const PAGE_SIZE = 25;

type Search = Record<string, string | string[] | undefined>;

/** Bad filter values from a hand-edited URL are dropped rather than failing the page. */
function readQuery(search: Search): ListRunsQuery {
  const raw = Object.fromEntries(LIST_QUERY_KEYS.map((k) => [k, [search[k]].flat()[0]]));
  const parsed = listRunsQuerySchema.safeParse({ ...raw, limit: PAGE_SIZE });
  if (parsed.success) return parsed.data;
  const keep = Object.fromEntries(Object.entries(raw).filter(([k, v]) => listRunsQuerySchema.shape[k as keyof ListRunsQuery].safeParse(v).success));
  return listRunsQuerySchema.parse({ ...keep, limit: PAGE_SIZE });
}

export default async function RunsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const query = readQuery(await searchParams);
  const db = getDb();
  const [list, scenarios, environments, canStopAll, t, tNav, format] = await Promise.all([
    listRuns(workspace.id, query),
    db.scenario.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.environment.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true, site: { select: { name: true } } }, orderBy: [{ site: { name: "asc" } }, { name: "asc" }] }),
    canInWorkspace(slug, "run.stopAll"),
    getTranslations("runs"),
    getTranslations("common"),
    getFormatter(),
  ]);
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const now = new Date();
  const filtered = Boolean(query.scenarioId || query.environmentId || query.status || query.trigger);
  const href = (page: number) => {
    const p = new URLSearchParams();
    for (const k of ["scenarioId", "environmentId", "status", "trigger"] as const) if (query[k]) p.set(k, query[k]!);
    if (page > 1) p.set("page", String(page));
    const s = p.toString();
    return `/w/${slug}/runs${s ? `?${s}` : ""}`;
  };
  const active = list.runs.some((r) => r.status === "queued" || r.status === "running");
  const select = `${inputClass} w-auto min-w-40`;

  return (
    <>
      <PageHeader
        crumbs={[workspace.name]}
        title={tNav("nav.runs")}
        actions={canStopAll ? <StopAllButton slug={slug} available={WRITE_ENDPOINTS.stopAll.available} /> : undefined}
      />
      {active && <RefreshWhileActive />}
      <div className="flex flex-col gap-4 p-8">
        <form method="get" className="flex flex-wrap items-end gap-3" aria-label={t("list.filters")}>
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("list.status")}
            <select name="status" defaultValue={query.status ?? ""} className={select}>
              <option value="">{t("list.any")}</option>
              {RUN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("list.scenario")}
            <select name="scenarioId" defaultValue={query.scenarioId ?? ""} className={select}>
              <option value="">{t("list.any")}</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("list.environment")}
            <select name="environmentId" defaultValue={query.environmentId ?? ""} className={select}>
              <option value="">{t("list.any")}</option>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.site.name} · {e.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("list.trigger")}
            <select name="trigger" defaultValue={query.trigger ?? ""} className={select}>
              <option value="">{t("list.any")}</option>
              {RUN_TRIGGERS.map((s) => (
                <option key={s} value={s}>
                  {t(`trigger.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonClass("secondary")}>
            {t("list.apply")}
          </button>
          {filtered && (
            <Link href={`/w/${slug}/runs`} className={buttonClass("ghost")}>
              {t("list.clear")}
            </Link>
          )}
        </form>

        {list.runs.length === 0 ? (
          <EmptyState title={filtered ? t("list.noMatches") : t("list.empty")} body={filtered ? undefined : t("list.emptyBody")}>
            {!filtered && (
              <Link href={`/w/${slug}/scenarios`} className={buttonClass("secondary")}>
                {t("list.openScenarios")}
              </Link>
            )}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-card border border-border bg-bg-surface shadow-e1">
            <table className="w-full text-left">
              <caption className="sr-only">{tNav("nav.runs")}</caption>
              <thead className="border-b border-border bg-bg-subtle text-label uppercase tracking-wider text-text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{t("list.status")}</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{t("list.run")}</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{t("list.environment")}</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{t("list.trigger")}</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{t("list.queued")}</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">{t("meta.duration")}</th>
                </tr>
              </thead>
              <tbody>
                {list.runs.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-b-0 hover:bg-bg-subtle/60">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5">
                        <StatusBadge status={r.status} label={t(`status.${r.status}`)} />
                        {r.cancelRequested && <span className="text-meta text-cancelled">{t("cancelRequestedBadge")}</span>}
                      </span>
                    </td>
                    <td className="max-w-[360px] px-4 py-3">
                      <Link href={`/w/${slug}/runs/${r.id}`} className="block truncate font-semibold underline-offset-2 hover:underline">
                        {r.trigger === "test" ? t("testRunTitle") : r.scenarioName}
                      </Link>
                      <span className="font-mono text-code-sm text-text-muted">#{shortRunId(r.id)}</span>
                    </td>
                    <td className="px-4 py-3">{r.environmentName}</td>
                    <td className="px-4 py-3 text-text-secondary">
                      {t(`trigger.${r.trigger}`)}
                      {r.requestedByName && <span className="block text-meta text-text-muted">{r.requestedByName}</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-code text-text-secondary">
                      <time dateTime={r.queuedAt} title={format.dateTime(new Date(r.queuedAt), { dateStyle: "medium", timeStyle: "medium" })}>
                        {format.relativeTime(new Date(r.queuedAt), now)}
                      </time>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-code text-text-secondary">{r.durationMs === null ? "—" : formatDuration(r.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {list.total > 0 && (
          <nav className="flex items-center justify-between text-meta text-text-muted" aria-label={t("list.pagination")}>
            <span>{t("list.showing", { from: (query.page - 1) * PAGE_SIZE + 1, to: Math.min(query.page * PAGE_SIZE, list.total), total: list.total })}</span>
            <span className="flex gap-2">
              {query.page > 1 ? (
                <Link href={href(query.page - 1)} className={buttonClass("secondary")} rel="prev">
                  {t("list.prev")}
                </Link>
              ) : (
                <span className={buttonClass("secondary", "pointer-events-none opacity-40")} aria-disabled="true">
                  {t("list.prev")}
                </span>
              )}
              <span className="self-center font-mono">
                {query.page} / {pages}
              </span>
              {query.page < pages ? (
                <Link href={href(query.page + 1)} className={buttonClass("secondary")} rel="next">
                  {t("list.next")}
                </Link>
              ) : (
                <span className={buttonClass("secondary", "pointer-events-none opacity-40")} aria-disabled="true">
                  {t("list.next")}
                </span>
              )}
            </span>
          </nav>
        )}
      </div>
    </>
  );
}
