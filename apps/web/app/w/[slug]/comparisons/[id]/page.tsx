import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { PageHeader } from "../../../../../components/ui";
import { ApiError } from "../../../../../lib/api";
import { getComparisonDetail } from "../../../../../lib/env-comparisons";
import { canInWorkspace, requireWorkspace } from "../../../../../lib/page";
import { RefreshWhileActive } from "../../runs/runs-live";
import { StatusBadge } from "../../runs/run-ui";
import { ComparisonActions, StructureDiff, VerdictBadge } from "../comparison-ui";

type Render = { browserVersion: string; deviceScaleFactor: number; viewport: { width: number; height: number }; fontSet: string } | null;

/** Display only: values stay raw in the data. */
const pct = (v: number) => (Math.round(v * 1000) / 1000).toString();

export default async function ComparisonPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const { workspace } = await requireWorkspace(slug);
  const detail = await getComparisonDetail(workspace.id, id).catch((err: unknown) => {
    if (err instanceof ApiError && err.code === "not_found") notFound();
    throw err;
  });
  const [canRecompare, canCancel, t, tRuns, tNav, format] = await Promise.all([
    canInWorkspace(slug, "run.create"),
    canInWorkspace(slug, "run.cancel"),
    getTranslations("comparisons"),
    getTranslations("runs"),
    getTranslations("common"),
    getFormatter(),
  ]);
  const active = detail.status === "running" || detail.status === "comparing";
  const runUrl = (runId: string | null) => (runId ? `/w/${slug}/runs/${runId}` : null);
  const artifactUrl = (runId: string | null, artifactId: string | null) => (runId && artifactId ? `/api/w/${slug}/runs/${runId}/artifacts/${artifactId}` : null);
  const fileUrl = (fileId: string | null) => (fileId ? `/api/w/${slug}/comparisons/${id}/files/${fileId}` : null);
  const renderText = (r: Render) =>
    r ? t("detail.render", { browser: r.browserVersion, scale: r.deviceScaleFactor, width: r.viewport.width, height: r.viewport.height, fonts: r.fontSet }) : "—";
  const reasonText = (reason: string | null) =>
    (reason ?? "")
      .split(";")
      .filter(Boolean)
      .map((r) => {
        const [code, fields] = r.split(":");
        const key = `detail.reason.${code}` as Parameters<typeof t>[0];
        return t.has(key) ? (t as (k: string, v?: Record<string, string>) => string)(key, { fields: fields ?? "" }) : code;
      });

  return (
    <>
      <PageHeader
        crumbs={[workspace.name, tNav("nav.comparisons")]}
        title={`${detail.scenario.name} · ${detail.leftEnvironment.name} ↔ ${detail.rightEnvironment.name}`}
        actions={<ComparisonActions slug={slug} id={id} status={detail.status} tolerance={detail.tolerance} canRecompare={canRecompare} canCancel={canCancel} />}
      />
      {active && <RefreshWhileActive />}
      <div className="flex flex-col gap-6 p-8">
        <section className="flex flex-wrap items-center gap-4 text-meta">
          <span className="font-semibold">{t(`status.${detail.status}`)}</span>
          <span>{t("list.screen")} <VerdictBadge verdict={detail.screenVerdict} label={detail.screenVerdict ? t(`verdict.${detail.screenVerdict}`) : "—"} /></span>
          <span>{t("list.structure")} <VerdictBadge verdict={detail.structureVerdict} label={detail.structureVerdict ? t(`verdict.${detail.structureVerdict}`) : "—"} /></span>
          <span>{t("detail.tolerance")} {detail.tolerance}%</span>
          <span>{t("detail.round", { round: detail.round })}</span>
          <span>{t(`location.${detail.location}`)}</span>
          {active && <span className="text-text-muted">{t("detail.refreshing")}</span>}
          {detail.error && <span className="text-error">{t("detail.error", { message: detail.error })}</span>}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-title font-semibold">{t("detail.children")}</h2>
          <ul className="flex flex-wrap gap-4 text-meta">
            {detail.runs
              .sort((a, b) => (a.comparisonSide === "left" ? -1 : b.comparisonSide === "left" ? 1 : 0))
              .map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <span className="font-semibold">{r.comparisonSide === "left" ? t("detail.left") : t("detail.right")}</span>
                  <Link href={runUrl(r.id)!} className="hover:underline">
                    <StatusBadge status={r.status} label={tRuns(`status.${r.status}`)} />
                  </Link>
                  <span className="text-text-muted">{r.comparisonSide === "left" ? detail.leftBaseUrl : detail.rightBaseUrl}</span>
                </li>
              ))}
          </ul>
        </section>

        <section className="flex flex-col gap-1 text-meta">
          <h2 className="text-title font-semibold">{t("detail.masking")}</h2>
          <p>{detail.masking?.enabled === false ? t("detail.maskingOff") : t("detail.maskingOn")}</p>
        </section>

        {detail.steps.map((s) => (
          <section key={s.stepId} className="flex flex-col gap-3 rounded-card border border-border bg-bg-surface p-4 shadow-e1">
            <header className="flex flex-wrap items-center gap-3">
              <h3 className="font-semibold">{s.name}</h3>
              <span>{t("list.screen")} <VerdictBadge verdict={s.screenVerdict} label={s.screenVerdict ? t(`verdict.${s.screenVerdict}`) : "—"} /></span>
              <span>{t("list.structure")} <VerdictBadge verdict={s.structureVerdict} label={s.structureVerdict ? t(`verdict.${s.structureVerdict}`) : "—"} /></span>
              {s.screenDiffPercent !== null && <span className="text-meta tabular-nums">{t("detail.diffPercent", { value: pct(s.screenDiffPercent) })}</span>}
              {s.screenShiftDiffPercent !== null && s.screenShift && (
                <span className="text-meta tabular-nums">{t("detail.shifted", { value: pct(s.screenShiftDiffPercent), x: (s.screenShift as { x: number }).x, y: (s.screenShift as { y: number }).y })}</span>
              )}
            </header>
            <p className="text-meta text-text-muted">
              {s.screenVerdict ? t(`detail.explain.${s.screenVerdict}`) : null} {reasonText(s.reason).join(" · ")}
            </p>
            {s.mask.length > 0 && <p className="text-meta">{t("detail.stepMask", { selectors: s.mask.join(", ") })}</p>}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {([["left", s.left], ["right", s.right]] as const).map(([side, c]) => {
                const src = artifactUrl(c.runId, c.artifactId);
                return (
                  <figure key={side} className="flex flex-col gap-1">
                    <figcaption className="text-meta font-semibold">{t(`detail.${side}`)}</figcaption>
                    {src ? (
                      <a href={src} target="_blank" rel="noreferrer"><img src={src} alt={`${t(`detail.${side}`)} · ${s.name}`} className="w-full rounded border border-border" /></a>
                    ) : (
                      <p className="text-meta text-text-muted">{t("detail.noImage")}</p>
                    )}
                    <p className="text-meta text-text-muted">{c.capturedAt ? t("detail.captured", { time: format.dateTime(new Date(c.capturedAt), { dateStyle: "short", timeStyle: "medium" }) }) : null}</p>
                    <p className="text-meta text-text-muted">{renderText(c.render as Render)}</p>
                  </figure>
                );
              })}
              <figure className="flex flex-col gap-1">
                <figcaption className="text-meta font-semibold">{t("detail.diff")}</figcaption>
                {fileUrl(s.screenDiffFileId) ? (
                  <a href={fileUrl(s.screenDiffFileId)!} target="_blank" rel="noreferrer"><img src={fileUrl(s.screenDiffFileId)!} alt={`${t("detail.diff")} · ${s.name}`} className="w-full rounded border border-border" /></a>
                ) : (
                  <p className="text-meta text-text-muted">{t("detail.noImage")}</p>
                )}
              </figure>
            </div>
            <div className="flex flex-col gap-2">
              <h4 className="text-meta font-semibold">{t("detail.structure")}</h4>
              {s.structureCounts && <p className="text-meta tabular-nums">{t("detail.counts", { moved: s.structureCounts.moved ?? 0, added: s.structureCounts.added ?? 0, removed: s.structureCounts.removed ?? 0, changed: s.structureCounts.changed ?? 0 })}</p>}
              {fileUrl(s.structureDiffFileId) && <StructureDiff url={fileUrl(s.structureDiffFileId)!} />}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
