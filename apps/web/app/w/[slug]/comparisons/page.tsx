import { COMPARISON_VERDICTS } from "@defe2end/shared";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { buttonClass, EmptyState, inputClass, PageHeader } from "../../../../components/ui";
import { getDb } from "../../../../lib/db";
import { listComparisons, listComparisonsQuerySchema } from "../../../../lib/env-comparisons";
import { requireWorkspace } from "../../../../lib/page";
import { RefreshWhileActive } from "../runs/runs-live";
import { VerdictBadge } from "./comparison-ui";

type Search = Record<string, string | string[] | undefined>;
const KEYS = ["verdict", "scenario", "siteId", "location", "from", "to"] as const;

export default async function ComparisonsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const search = await searchParams;
  // Bad values from a hand-edited URL are dropped.
  const raw = Object.fromEntries(KEYS.map((k) => [k, [search[k]].flat()[0] || undefined]));
  const keep = Object.fromEntries(Object.entries(raw).filter(([k, v]) => listComparisonsQuerySchema.shape[k as (typeof KEYS)[number]].safeParse(v).success));
  const query = listComparisonsQuerySchema.parse(keep);
  const [list, sites, t, tNav, format] = await Promise.all([
    listComparisons(workspace.id, query),
    getDb().site.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    getTranslations("comparisons"),
    getTranslations("common"),
    getFormatter(),
  ]);
  const filtered = KEYS.some((k) => query[k]);
  const active = list.comparisons.some((c) => c.status === "running" || c.status === "comparing");
  const select = `${inputClass} w-auto min-w-36`;
  return (
    <>
      <PageHeader crumbs={[workspace.name]} title={tNav("nav.comparisons")} />
      {active && <RefreshWhileActive />}
      <div className="flex flex-col gap-4 p-8">
        <form method="get" className="flex flex-wrap items-end gap-3" aria-label={t("list.filters")}>
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("list.verdict")}
            <select name="verdict" defaultValue={query.verdict ?? ""} className={select}>
              <option value="">{t("list.any")}</option>
              {COMPARISON_VERDICTS.map((v) => (
                <option key={v} value={v}>{t(`verdict.${v}`)}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("list.scenario")}
            <input name="scenario" defaultValue={query.scenario ?? ""} className={select} />
          </label>
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("list.site")}
            <select name="siteId" defaultValue={query.siteId ?? ""} className={select}>
              <option value="">{t("list.any")}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("list.location")}
            <select name="location" defaultValue={query.location ?? ""} className={select}>
              <option value="">{t("list.any")}</option>
              <option value="server">{t("location.server")}</option>
              <option value="desktop">{t("location.desktop")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("list.from")}
            <input type="date" name="from" defaultValue={query.from ?? ""} className={select} />
          </label>
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("list.to")}
            <input type="date" name="to" defaultValue={query.to ?? ""} className={select} />
          </label>
          <button type="submit" className={buttonClass("secondary")}>{t("list.apply")}</button>
          {filtered && (
            <Link href={`/w/${slug}/comparisons`} className={buttonClass("ghost")}>{t("list.clear")}</Link>
          )}
        </form>
        {list.comparisons.length === 0 ? (
          <EmptyState title={filtered ? t("list.noMatches") : t("list.empty")} body={filtered ? undefined : t("list.emptyBody")} />
        ) : (
          <div className="overflow-x-auto rounded-card border border-border bg-bg-surface shadow-e1">
            <table className="w-full text-left">
              <caption className="sr-only">{tNav("nav.comparisons")}</caption>
              <thead className="border-b border-border bg-bg-subtle text-label uppercase tracking-wider text-text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{t("list.status")}</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{t("list.scenario")}</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{t("list.environments")}</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{t("list.screen")}</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{t("list.structure")}</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{t("list.location")}</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{t("list.started")}</th>
                </tr>
              </thead>
              <tbody>
                {list.comparisons.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-b-0 hover:bg-bg-subtle/60">
                    <td className="px-4 py-2.5 text-meta">{t(`status.${c.status}`)}</td>
                    <td className="px-4 py-2.5">
                      <Link href={`/w/${slug}/comparisons/${c.id}`} className="font-semibold text-text-primary hover:underline">{c.scenario.name}</Link>
                      <div className="text-meta text-text-muted">{c.site.name}</div>
                    </td>
                    <td className="px-4 py-2.5 text-meta">{c.leftEnvironment.name} ↔ {c.rightEnvironment.name}</td>
                    <td className="px-4 py-2.5"><VerdictBadge verdict={c.screenVerdict} label={c.screenVerdict ? t(`verdict.${c.screenVerdict}`) : "—"} /></td>
                    <td className="px-4 py-2.5"><VerdictBadge verdict={c.structureVerdict} label={c.structureVerdict ? t(`verdict.${c.structureVerdict}`) : "—"} /></td>
                    <td className="px-4 py-2.5 text-meta">{t(`location.${c.location}`)}</td>
                    <td className="px-4 py-2.5 text-meta tabular-nums">{format.dateTime(new Date(c.createdAt), { dateStyle: "short", timeStyle: "short" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
