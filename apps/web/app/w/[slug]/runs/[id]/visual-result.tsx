"use client";

// Visual regression of a screenshot step (stage 7 contract section 4): verdict badge, baseline | current | diff
// for shifts and changes, and approval as the new baseline for people who may edit scenarios.
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createContext, useContext, useState } from "react";
import { Button } from "../../../../../components/ui";
import type { ArtifactView, StepVisualView } from "../../../../../lib/run-read";

export const VisualApproveContext = createContext<{ slug: string; runId: string; canApprove: boolean }>({ slug: "", runId: "", canApprove: false });

const BADGE: Record<StepVisualView["verdict"], string> = {
  changed: "border-warn/40 bg-timed-out-soft text-warn",
  size_mismatch: "border-warn/40 bg-timed-out-soft text-warn",
  shifted: "border-border-strong bg-bg-subtle text-text-secondary",
  match: "border-pass/30 text-pass",
  created: "border-accent/30 text-accent",
  skipped: "border-border text-text-muted",
  incomparable: "border-border-strong text-text-secondary",
};

/** Display only; verdicts use the raw value. */
function percent(v: number): string {
  if (v === 0) return "0%";
  if (v < 0.01) return "<0.01%";
  return `${v.toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function VisualBadge({ visual }: { visual: StepVisualView }) {
  const t = useTranslations("runs.visual");
  return <span className={`inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-meta font-semibold ${BADGE[visual.verdict]}`}>{t(`verdict.${visual.verdict}`)}</span>;
}

export function VisualDetail({ visual, shot, diff }: { visual: StepVisualView; shot: ArtifactView | undefined; diff: ArtifactView | undefined }) {
  const t = useTranslations("runs.visual");
  const { slug, runId, canApprove } = useContext(VisualApproveContext);
  const router = useRouter();
  const [state, setState] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
  const side = visual.verdict === "shifted" || visual.verdict === "changed";

  async function approve() {
    setState({ busy: true, message: null });
    const res = await fetch(`/api/w/${slug}/runs/${runId}/steps/${visual.stepResultId}/approve-baseline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: visual.baseline?.currentVersion ?? 0 }),
    });
    const body = (await res.json().catch(() => null)) as { version?: number; error?: { message?: string } } | null;
    if (res.ok) {
      setState({ busy: false, message: t("approved", { version: body?.version ?? 0 }) });
      router.refresh();
    } else setState({ busy: false, message: res.status === 409 && body?.error?.message?.includes("meantime") ? t("approveConflict") : t("approveFailed", { message: body?.error?.message ?? String(res.status) }) });
  }

  return (
    <div className="flex flex-col gap-2 rounded-control border border-border bg-bg-surface p-3 text-body">
      <div className="flex flex-wrap items-center gap-2">
        <VisualBadge visual={visual} />
        {visual.baseline && <span className="font-mono text-code-sm text-text-muted">{t("baselineVersion", { version: visual.baseline.version })}</span>}
        {visual.diffPercent !== null && <span className="font-mono text-code-sm">{t("difference", { diff: percent(visual.diffPercent) })}</span>}
        {visual.shiftDiffPercent !== null && visual.shift && <span className="font-mono text-code-sm text-text-secondary">{t("shiftDifference", { diff: percent(visual.shiftDiffPercent), x: visual.shift.x, y: visual.shift.y })}</span>}
      </div>
      {visual.verdict === "created" && <p className="text-text-secondary">{t("createdNote")}</p>}
      {visual.verdict === "skipped" && <p className="text-text-secondary">{t("skippedNote")}</p>}
      {visual.verdict === "incomparable" && <p className="text-text-secondary">{t("incomparableNote", { conditions: visual.differs.map((c) => t(`conditions.${c}`)).join(", ") || "—" })}</p>}
      {visual.baseline && visual.baseline.version !== visual.baseline.currentVersion && <p className="text-meta text-text-muted">{t("olderBaseline", { version: visual.baseline.version, current: visual.baseline.currentVersion })}</p>}
      {side && visual.baseline && (
        <div className="grid gap-2 sm:grid-cols-3">
          {[
            { label: t("baseline"), url: visual.baseline.url },
            { label: t("current"), url: shot?.url },
            { label: t("diff"), url: diff?.url },
          ].map((pane) => (
            <figure key={pane.label} className="flex flex-col gap-1">
              <figcaption className="text-label uppercase tracking-wider text-text-muted">{pane.label}</figcaption>
              {pane.url ? (
                <a href={pane.url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API response, not a static asset */}
                  <img src={pane.url} alt={pane.label} loading="lazy" className="h-36 w-full rounded-control border border-border object-cover object-top" />
                </a>
              ) : (
                <span className="flex h-36 items-center justify-center rounded-control border border-dashed border-border text-text-muted">—</span>
              )}
            </figure>
          ))}
        </div>
      )}
      {side && canApprove && visual.approvable && (
        <div className="flex items-center gap-3">
          <Button type="button" onClick={() => void approve()} disabled={state.busy}>
            {state.busy ? t("approving") : t("approve")}
          </Button>
          {state.message && <span role="status" className="text-meta text-text-secondary">{state.message}</span>}
        </div>
      )}
    </div>
  );
}
