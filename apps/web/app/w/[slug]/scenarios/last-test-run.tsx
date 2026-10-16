"use client";

import { isTerminalRunStatus } from "@defe2end/shared";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { RunDetail } from "../../../../lib/run-read";
import { StatusBadge } from "../runs/run-ui";
import { useHydrated } from "../runs/use-hydrated";
import { PopIn, SwapIn } from "../../../transitions/motion";

// The editor's last test run (test runs stay out of the scenario's history and list by design, so the editor
// shows their outcome itself). The server links a test run to its scenario with Run.testOfScenarioId.

export interface TestRunSummary {
  status: RunDetail["status"];
  active: boolean;
  /** Finished steps of the latest attempt / all steps. */
  done: number;
  total: number;
  /** 1-based number, name and reason of the first step that didn't pass. */
  failedStep: { number: number; name: string; reason: string | null } | null;
  location: RunDetail["location"];
  deviceLabel: string | null;
  at: string;
}

export function summarizeTestRun(run: RunDetail): TestRunSummary {
  const failed = run.steps.find((s) => s.result && (s.result.status === "failed" || s.result.status === "error" || s.result.status === "timed_out"));
  return {
    status: run.status,
    active: !isTerminalRunStatus(run.status),
    done: run.steps.filter((s) => s.result !== null).length,
    total: run.steps.length,
    failedStep: failed ? { number: failed.index + 1, name: failed.name ?? failed.action, reason: failed.result!.errorMessage ?? run.errorMessage } : null,
    location: run.location,
    deviceLabel: run.deviceLabel,
    at: run.finishedAt ?? run.startedAt ?? run.queuedAt,
  };
}

/** Polls the run while it is active; disappears when the run is gone (deleted after 24 hours). */
export function LastTestRun({ slug, runId, onGone }: { slug: string; runId: string; onGone: () => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRun(null);
    const load = async () => {
      const res = await fetch(`/api/w/${slug}/runs/${runId}`).catch(() => null);
      if (!alive) return;
      if (res?.status === 404) return onGone();
      if (!res?.ok) {
        setFailed(true);
        timer = setTimeout(load, 5_000);
        return;
      }
      const body = (await res.json()) as RunDetail;
      if (!alive) return;
      setFailed(false);
      setRun(body);
      if (!isTerminalRunStatus(body.status)) timer = setTimeout(load, 2_000);
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // onGone is a fresh closure each render; the run id decides what to load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, runId]);
  return <TestRunCard slug={slug} runId={runId} summary={run ? summarizeTestRun(run) : null} loadFailed={failed} />;
}

export function TestRunCard({ slug, runId, summary, loadFailed }: { slug: string; runId: string; summary: TestRunSummary | null; loadFailed?: boolean }) {
  const t = useTranslations("scenarios.lastTestRun");
  const tRuns = useTranslations("runs");
  const format = useFormatter();
  const hydrated = useHydrated();
  // One line of the "Runs" section: no own background or edge — the status is the badge.
  return (
    <div role="group" aria-label={t("title")} className="t-resize flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <span className="w-36 shrink-0 text-label uppercase tracking-wider text-text-muted">{t("title")}</span>
      {!summary ? (
        <span className="text-meta text-text-muted">{loadFailed ? t("loadFailed") : t("loading")}</span>
      ) : (
        <>
          <SwapIn value={summary.status}>
            <StatusBadge status={summary.status} label={tRuns(`status.${summary.status}`)} />
          </SwapIn>
          {summary.active && summary.total > 0 && (
            <span className="font-mono text-code text-text-secondary">
              <PopIn value={summary.done}>{t("progress", { done: summary.done, total: summary.total })}</PopIn>
            </span>
          )}
          <span className="text-meta text-text-secondary">
            {summary.location === "desktop"
              ? summary.active
                ? t("runningOnPc", { label: summary.deviceLabel ?? "—" })
                : t("ranOnPc", { label: summary.deviceLabel ?? "—" })
              : t("server")}
          </span>
          {hydrated && !summary.active && <span className="font-mono text-code text-text-muted">{format.relativeTime(new Date(summary.at))}</span>}
          {summary.failedStep && (
            <span className="min-w-0 basis-full truncate pl-40 text-meta text-fail">
              {t("failedStep", { number: summary.failedStep.number, name: summary.failedStep.name })}
              {summary.failedStep.reason && <span className="font-mono text-code"> — {summary.failedStep.reason}</span>}
            </span>
          )}
          <Link href={`/w/${slug}/runs/${runId}`} className="ml-auto text-meta font-semibold text-text-primary underline-offset-2 hover:underline">
            {t("open")} →
          </Link>
        </>
      )}
    </div>
  );
}
