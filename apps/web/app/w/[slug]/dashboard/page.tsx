import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { buttonClass, EmptyState, inputClass, PageHeader } from "../../../../components/ui";
import { DASHBOARD_PERIODS, parsePeriod, type DailyPoint, type FailingItem, type FailingKind } from "../../../../lib/dashboard-calc";
import { loadDashboard, type DashboardData } from "../../../../lib/dashboard";
import { getDb } from "../../../../lib/db";
import { requireWorkspace } from "../../../../lib/page";
import { formatDuration, STATUS_FILL } from "../runs/run-ui";

type Search = Record<string, string | string[] | undefined>;
type Translate = Awaited<ReturnType<typeof getTranslations<"runs">>>;
type Format = Awaited<ReturnType<typeof getFormatter>>;

/** Kind badges reuse the run status colours: new = failed, consecutive = error, intermittent = timed out. */
const KIND_CLASS: Record<FailingKind, string> = {
  new: "bg-fail-soft text-fail",
  consecutive: "bg-error-soft text-error",
  intermittent: "bg-timed-out-soft text-timed-out",
};

const first = (v: string | string[] | undefined) => [v].flat()[0] || undefined;

export default async function DashboardPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const search = await searchParams;
  const filter = { period: parsePeriod(first(search.period)), siteId: first(search.siteId), environmentId: first(search.environmentId) };
  const db = getDb();
  const [data, sites, environments, t, tNav, format] = await Promise.all([
    loadDashboard(workspace, filter),
    db.site.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.environment.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true, siteId: true, site: { select: { name: true } } }, orderBy: [{ site: { name: "asc" } }, { name: "asc" }] }),
    getTranslations("runs"),
    getTranslations("common"),
    getFormatter(),
  ]);
  const td = (key: string, values?: Record<string, string | number>) => t(`dashboard.${key}` as Parameters<Translate>[0], values as never);
  const percent = (rate: number | null) => (rate === null ? "—" : format.number(rate, { style: "percent", maximumFractionDigits: 1 }));
  const periodHref = (days: number) => {
    const p = new URLSearchParams({ period: String(days) });
    if (filter.siteId) p.set("siteId", filter.siteId);
    if (filter.environmentId) p.set("environmentId", filter.environmentId);
    return `/w/${slug}/dashboard?${p}`;
  };
  const envChoices = filter.siteId ? environments.filter((e) => e.siteId === filter.siteId) : environments;
  const select = `${inputClass} w-auto min-w-40`;
  const { summary } = data;

  return (
    <>
      <PageHeader crumbs={[workspace.name]} title={tNav("nav.dashboard")} />
      <div className="flex flex-col gap-6 p-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <nav className="flex gap-1" aria-label={td("period")}>
            {DASHBOARD_PERIODS.map((days) => (
              <Link key={days} href={periodHref(days)} aria-current={days === filter.period ? "page" : undefined} className={buttonClass(days === filter.period ? "primary" : "secondary")}>
                {td("periodDays", { days })}
              </Link>
            ))}
          </nav>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="period" value={filter.period} />
            <label className="flex flex-col gap-1 text-meta font-semibold">
              {td("site")}
              <select name="siteId" defaultValue={filter.siteId ?? ""} className={select}>
                <option value="">{td("all")}</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-meta font-semibold">
              {td("environment")}
              <select name="environmentId" defaultValue={filter.environmentId ?? ""} className={select}>
                <option value="">{td("all")}</option>
                {envChoices.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.site.name} · {e.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={buttonClass("secondary")}>
              {td("apply")}
            </button>
          </form>
        </div>
        <p className="-mt-3 text-meta text-text-muted">{td("subtitle", { days: filter.period, timezone: workspace.timezone })}</p>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Card label={td("cards.passRate")} value={percent(summary.passRate)} hint={td("cards.passRateHint")} />
          <Card label={td("cards.runs")} value={format.number(summary.runCount)} />
          <Card label={td("cards.avgDuration")} value={summary.avgDurationMs === null ? "—" : formatDuration(summary.avgDurationMs)} />
          <Card label={td("cards.failingNow")} value={format.number(summary.failingNow)} tone={summary.failingNow > 0 ? "text-fail" : undefined} />
          <Card
            label={td("cards.fires")}
            value={format.number(summary.missed + summary.skipped + summary.refused)}
            hint={td("cards.firesDetail", { missed: summary.missed, skipped: summary.skipped, refused: summary.refused })}
          />
        </section>

        <Panel title={td("failing.title")}>
          <FailingList data={data} slug={slug} td={td} format={format} />
        </Panel>

        <Panel title={td("trend.title")}>
          {data.daily.every((d) => d.rate === null) ? <p className="p-4 text-text-muted">{td("trend.empty")}</p> : <Trend points={data.daily} td={td} percent={percent} />}
        </Panel>

        <Panel title={td("top.title")}>
          {data.top.length === 0 ? (
            <p className="p-4 text-text-muted">{td("top.empty")}</p>
          ) : (
            <table className="w-full text-left">
              <thead className="border-b border-border bg-bg-subtle text-label uppercase tracking-wider text-text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{td("top.scenario")}</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">{td("top.failures")}</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">{td("top.runs")}</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">{td("top.lastFailed")}</th>
                </tr>
              </thead>
              <tbody>
                {data.top.map((r) => (
                  <tr key={r.scenarioId} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-3">
                      <Link href={`/w/${slug}/runs?scenarioId=${r.scenarioId}`} className="font-semibold underline-offset-2 hover:underline">
                        {r.scenarioName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-code text-fail">{r.failures}</td>
                    <td className="px-4 py-3 text-right font-mono text-code text-text-secondary">{r.runs}</td>
                    <td className="px-4 py-3 font-mono text-code text-text-secondary">{format.dateTime(r.lastFailedAt, { dateStyle: "medium", timeStyle: "short", timeZone: workspace.timezone })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}

function Card({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-card border border-border bg-bg-surface p-4 shadow-e1">
      <p className="text-label uppercase tracking-wider text-text-muted">{label}</p>
      <p className={`mt-1 font-mono text-title-lg ${tone ?? ""}`}>{value}</p>
      {hint && <p className="mt-1 text-meta text-text-muted">{hint}</p>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-card border border-border bg-bg-surface shadow-e1">
      <h2 className="border-b border-border px-4 py-3 text-title-sm">{title}</h2>
      {children}
    </section>
  );
}

type Td = (key: string, values?: Record<string, string | number>) => string;

function FailingList({ data, slug, td, format }: { data: DashboardData; slug: string; td: Td; format: Format }) {
  const { clusters, singles, causes } = data.failing;
  if (clusters.length === 0 && singles.length === 0) {
    return (
      <div className="p-4">
        <EmptyState title={td("failing.empty")} />
      </div>
    );
  }
  const row = (item: FailingItem, showCause: boolean) => {
    const cause = causes.get(item.lastRunId);
    return (
      <li key={item.lastRunId} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-3 last:border-b-0">
        <span className={`inline-flex h-6 shrink-0 items-center rounded-full px-2 text-meta font-semibold ${KIND_CLASS[item.kind]}`}>{td(`failing.kind.${item.kind}`)}</span>
        <span className="min-w-0 flex-1">
          <Link href={`/w/${slug}/runs/${item.lastRunId}`} className="block truncate font-semibold underline-offset-2 hover:underline">
            {item.scenarioName}
          </Link>
          <span className="block text-meta text-text-muted">
            {item.environmentName}
            {item.streak >= 2 && <> · {td("failing.streak", { count: item.streak })}</>}
          </span>
          {showCause && cause && <CauseLine cause={cause} td={td} />}
        </span>
        <span className="flex gap-0.5" role="img" aria-label={`${td("failing.history")}: ${item.history.join(", ")}`}>
          {item.history.map((status, i) => (
            <span key={i} className={`h-4 w-2 rounded-sm ${STATUS_FILL[status]}`} />
          ))}
        </span>
        <time className="font-mono text-code text-text-secondary" dateTime={item.lastAt.toISOString()}>
          {format.relativeTime(item.lastAt, new Date())}
        </time>
      </li>
    );
  };
  return (
    <div className="flex flex-col">
      {clusters.map((c, i) => (
        <div key={i} className="border-b border-border">
          <div className="bg-bg-subtle px-4 py-2">
            <p className="text-meta font-semibold">{td("failing.cluster", { count: c.items.length })}</p>
            <CauseLine cause={causes.get(c.items[0]!.lastRunId)!} td={td} />
          </div>
          <ul>{c.items.map((item) => row(item, false))}</ul>
        </div>
      ))}
      {singles.length > 0 && <ul>{singles.map((item) => row(item, true))}</ul>}
    </div>
  );
}

function CauseLine({ cause, td }: { cause: { action: string | null; stepIndex: number | null; reason: string }; td: Td }) {
  return (
    <span className="block truncate font-mono text-code-sm text-text-secondary" title={cause.reason}>
      {cause.stepIndex === null ? td("failing.noStep") : td("failing.step", { number: cause.stepIndex + 1, action: cause.action ?? "" })} — {cause.reason}
    </span>
  );
}

/** Hand-drawn line of daily pass rates; days without runs break the line. */
function Trend({ points, td, percent }: { points: DailyPoint[]; td: Td; percent: (rate: number | null) => string }) {
  const W = 720;
  const H = 160;
  const pad = { l: 36, r: 12, t: 12, b: 24 };
  const x = (i: number) => pad.l + (points.length === 1 ? 0 : (i / (points.length - 1)) * (W - pad.l - pad.r));
  const y = (rate: number) => pad.t + (1 - rate) * (H - pad.t - pad.b);
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p.rate === null) {
      if (current.length) segments.push(current.join(" "));
      current = [];
    } else current.push(`${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`);
  });
  if (current.length) segments.push(current.join(" "));
  const labelEvery = Math.ceil(points.length / 7);

  return (
    <div className="p-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={td("trend.title")}>
        {[0, 0.5, 1].map((r) => (
          <g key={r}>
            <line x1={pad.l} x2={W - pad.r} y1={y(r)} y2={y(r)} className="stroke-border" strokeWidth={1} />
            <text x={pad.l - 6} y={y(r) + 3} textAnchor="end" className="fill-text-muted text-label">
              {Math.round(r * 100)}%
            </text>
          </g>
        ))}
        {segments.map((pts, i) => (
          <polyline key={i} points={pts} fill="none" className="stroke-pass" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {points.map((p, i) => (
          <g key={p.day}>
            {p.rate !== null && (
              <circle cx={x(i)} cy={y(p.rate)} r={points.length > 31 ? 2 : 3} className={p.rate < 1 ? "fill-fail" : "fill-pass"}>
                <title>{td("trend.point", { day: p.day, rate: percent(p.rate), passed: p.passed, failed: p.failed })}</title>
              </circle>
            )}
            {p.rate === null && <title>{td("trend.noRuns", { day: p.day })}</title>}
            {(i % labelEvery === 0 || i === points.length - 1) && (
              <text x={x(i)} y={H - 6} textAnchor="middle" className="fill-text-muted text-label">
                {p.day.slice(5)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
