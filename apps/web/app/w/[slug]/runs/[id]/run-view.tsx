"use client";

import { isTerminalRunStatus } from "@defe2end/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Alert, Button } from "../../../../../components/ui";
import { applyRunEvent, type RunEvent } from "../../../../../lib/run-event-merge";
import type { RunChange } from "../../../../../lib/run-changes";
import type { ArtifactView, RunChangesView, RunDetail, RunStepView } from "../../../../../lib/run-read";
import {
  AlertIcon,
  CalendarIcon,
  ChevronIcon,
  ClockIcon,
  FileIcon,
  HistoryIcon,
  InfraIcon,
  LayersIcon,
  PackageIcon,
  RerunFailedIcon,
  RerunIcon,
  ServerIcon,
  SparklesIcon,
  StatusBadge,
  StatusIcon,
  StopIcon,
  TerminalIcon,
  UserIcon,
  formatDuration,
  shortRunId,
  STATUS_SOFT,
  STATUS_TEXT,
  stepNumber,
  type StepDisplayStatus,
} from "../run-ui";
import { useHydrated } from "../use-hydrated";
import { DiagnosisPanel } from "./diagnosis-panel";
import { hasVisualWarningText, VisualApproveContext, VisualBadge, VisualDetail, VisualWarningText } from "./visual-result";
import { PopIn, SwapIn } from "../../../../transitions/motion";

type T = ReturnType<typeof useTranslations<"runs">>;

export interface RunPermissions {
  cancel: boolean;
  create: boolean;
  /** `scenario.write`: approve a screenshot as the new visual baseline. */
  approveBaseline?: boolean;
}

const PROBLEM = new Set(["failed", "error", "timed_out", "cancelled"]);

function stepStatus(step: RunStepView, run: RunDetail, runningIndex: number): StepDisplayStatus {
  if (step.result) return step.result.status;
  if (run.status === "running" && step.index === runningIndex) return "running";
  return run.status === "queued" || run.status === "running" ? "queued" : "notRun";
}

/** The step a running run is on: the first one without a result. */
const runningIndexOf = (run: RunDetail) => run.steps.findIndex((s) => !s.result);

/** Live copy of the run: SSE while it isn't finished, merged by step index and artifact id (contract section 7). */
function useLiveRun(slug: string, initial: RunDetail) {
  const router = useRouter();
  const [run, setRun] = useState(initial);
  const [connection, setConnection] = useState<"idle" | "live" | "reconnecting" | "lost">("idle");
  useEffect(() => setRun(initial), [initial]);
  const finished = isTerminalRunStatus(initial.status);
  useEffect(() => {
    if (finished) return;
    const source = new EventSource(`/api/w/${slug}/runs/${initial.id}/events`);
    let ended = false;
    const onEvent = (e: MessageEvent<string>) => {
      const event = JSON.parse(e.data) as RunEvent;
      setRun((current) => applyRunEvent(current, event) ?? current);
      if (event.type === "end") {
        ended = true;
        source.close();
        setConnection("idle");
        // Re-reads the page so "changed since last pass" covers the finished run.
        router.refresh();
      } else {
        setConnection("live");
      }
    };
    for (const type of ["snapshot", "update", "end"]) source.addEventListener(type, onEvent as EventListener);
    source.onerror = () => {
      if (!ended) setConnection(source.readyState === EventSource.CLOSED ? "lost" : "reconnecting");
    };
    return () => source.close();
  }, [slug, initial.id, finished, router]);
  return { run, setRun, connection };
}

/** Wall clock, ticking once a second while `on`. Null until mounted (server and hydration render no clock). */
function useNow(on: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export function RunView({
  slug,
  initial,
  changes,
  can,
  rerunFailedAvailable,
}: {
  slug: string;
  initial: RunDetail;
  changes: RunChangesView | null;
  can: RunPermissions;
  rerunFailedAvailable: boolean;
}) {
  const t = useTranslations("runs");
  const { run, setRun, connection } = useLiveRun(slug, initial);
  const active = run.status === "queued" || run.status === "running";
  const now = useNow(active);
  const runningIndex = runningIndexOf(run);
  // Attempt switcher (spec 4.3): the latest attempt by default; earlier ones are read-only views.
  const [attempt, setAttempt] = useState<number | null>(null);
  const shown = attempt === null || attempt >= run.attemptCount ? run.attemptCount : attempt;
  const earlier = run.previousAttempts.find((a) => a.attempt === shown);
  const view: RunDetail = earlier ? { ...run, steps: earlier.steps, artifacts: run.artifacts.filter((a) => a.attempt === shown) } : { ...run, artifacts: run.artifacts.filter((a) => a.attempt === shown) };
  const screenshots = view.artifacts.filter((a) => a.kind === "screenshot");
  const videos = view.artifacts.filter((a) => a.kind === "video");

  return (
    <div className="flex flex-col gap-6 p-8">
      {connection === "reconnecting" && <Alert tone="info">{t("live.reconnecting")}</Alert>}
      {connection === "lost" && (
        <Alert>
          {t("live.lost")}{" "}
          <button type="button" className="font-semibold underline underline-offset-2" onClick={() => window.location.reload()}>
            {t("live.reload")}
          </button>
        </Alert>
      )}
      <Header slug={slug} run={run} now={now} runningIndex={runningIndex} can={can} rerunFailedAvailable={rerunFailedAvailable} live={connection === "live"} onCancelled={(patch) => setRun((r) => ({ ...r, ...patch }))} />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-3">
          {run.attemptCount > 1 && <AttemptSwitcher count={run.attemptCount} shown={shown} onPick={setAttempt} t={t} />}
          <VisualApproveContext.Provider value={{ slug, runId: run.id, canApprove: can.approveBaseline === true }}>
            <Steps run={view} runningIndex={earlier ? -1 : runningIndex} t={t} />
          </VisualApproveContext.Provider>
        </div>
        <aside className="flex flex-col gap-6" aria-label={t("side.label")}>
          {changes && <Changes slug={slug} run={run} view={changes} />}
          {videos.map((v) => (
            <Recording key={v.id} artifact={v} t={t} />
          ))}
          {screenshots.length > 0 && <Screenshots run={view} shots={screenshots} t={t} />}
          <RunnerCard run={run} t={t} />
          <DiagnosisPanel slug={slug} run={view} attempt={shown} />
        </aside>
      </div>
    </div>
  );
}

/** Radio-style switch between whole-run attempts; arrow keys move between them. */
function AttemptSwitcher({ count, shown, onPick, t }: { count: number; shown: number; onPick: (attempt: number) => void; t: T }) {
  const attempts = Array.from({ length: count }, (_, i) => i + 1);
  return (
    <div
      role="radiogroup"
      aria-label={t("attempts.label")}
      className="inline-flex self-start rounded-control border border-border bg-bg-subtle p-0.5"
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = ((shown - 1 + step + count) % count) + 1;
        onPick(next);
        (e.currentTarget.querySelector(`[data-attempt="${next}"]`) as HTMLElement | null)?.focus();
      }}
    >
      {attempts.map((a) => (
        <button
          key={a}
          type="button"
          role="radio"
          data-attempt={a}
          aria-checked={a === shown}
          tabIndex={a === shown ? 0 : -1}
          onClick={() => onPick(a)}
          className={`flex h-7 items-center rounded-[6px] px-3 text-body ${a === shown ? "bg-bg-surface font-semibold shadow-e1" : "text-text-secondary"}`}
        >
          {a === count ? t("attempts.latest", { attempt: a }) : t("attempts.item", { attempt: a })}
        </button>
      ))}
    </div>
  );
}

// --- Header ------------------------------------------------------------------------------

function useActionLabel() {
  const ts = useTranslations("scenarios.actions");
  return (action: string) => (ts.has(action as never) ? ts(action as never) : action);
}

function Header({
  slug,
  run,
  now,
  runningIndex,
  can,
  rerunFailedAvailable,
  live,
  onCancelled,
}: {
  slug: string;
  run: RunDetail;
  now: number | null;
  runningIndex: number;
  can: RunPermissions;
  rerunFailedAvailable: boolean;
  live: boolean;
  onCancelled: (patch: Partial<RunDetail>) => void;
}) {
  const t = useTranslations("runs");
  const format = useFormatter();
  const actionLabel = useActionLabel();
  const router = useRouter();
  const [busy, setBusy] = useState<null | "cancel" | "rerun" | "rerunFailed">(null);
  const [error, setError] = useState<string>();
  const active = run.status === "queued" || run.status === "running";
  const infra = run.status === "error";
  const total = run.steps.length;
  const problem = run.steps.find((s) => s.result && PROBLEM.has(s.result.status));
  const passed = run.steps.filter((s) => s.result?.status === "passed").length;

  const summary = (() => {
    if (run.cancelRequested) return t("summary.cancelRequested");
    switch (run.status) {
      case "queued":
        return t("summary.queued");
      case "running": {
        const step = run.steps[runningIndex];
        return step
          ? t("summary.running", { step: runningIndex + 1, total, action: actionLabel(step.action), target: step.selector ?? step.url ?? step.value ?? step.expected ?? "" })
          : t("summary.finishing");
      }
      case "passed":
        return t("summary.passed", { total });
      case "failed": {
        const r = problem?.result;
        const head = t("summary.failedAt", { step: (problem?.index ?? 0) + 1, total });
        if (!r) return head;
        const detail = r.errorMessage?.split("\n")[0];
        return [head, detail, r.attempts > 1 ? t("summary.afterAttempts", { count: r.attempts }) : null].filter(Boolean).join(" — ");
      }
      case "error":
        return run.errorCode && t.has(`runError.${run.errorCode}` as never)
          ? (t as unknown as (key: string, values: Record<string, number>) => string)(`runError.${run.errorCode}`, { step: (problem?.index ?? (runningIndex === -1 ? total - 1 : runningIndex)) + 1 })
          : problem
            ? t("summary.errorAt", { step: problem.index + 1, total })
            : t("summary.error");
      case "cancelled": {
        const at = run.steps.find((s) => s.result?.status === "cancelled");
        return run.errorCode === "group_stopped" ? t("summary.groupStopped") : at ? t("summary.cancelledAt", { step: at.index + 1 }) : t("summary.cancelled");
      }
      case "timed_out": {
        const at = run.steps.find((s) => s.result?.status === "timed_out");
        return at ? t("summary.timedOutAt", { step: at.index + 1 }) : t("summary.timedOut");
      }
    }
  })();

  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
  const durationMs = run.startedAt && end !== null ? end - new Date(run.startedAt).getTime() : null;
  const startedBy = run.trigger === "manual" || run.trigger === "test" ? (run.requestedByName ?? t("meta.deletedUser")) : t(`trigger.${run.trigger}`);

  async function cancel() {
    setBusy("cancel");
    setError(undefined);
    const res = await fetch(`/api/w/${slug}/runs/${run.id}/cancel`, { method: "POST" });
    setBusy(null);
    if (!res.ok) return setError(t("actions.cancelFailed"));
    const body = (await res.json()) as { status: RunDetail["status"]; cancelRequested: boolean; cancelRequestedAt: string | null; finishedAt: string | null };
    onCancelled(body);
    if (isTerminalRunStatus(body.status)) router.refresh();
  }

  async function rerun() {
    if (!run.scenarioId || !run.environmentId) return;
    setBusy("rerun");
    setError(undefined);
    const res = await fetch(`/api/w/${slug}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ scenarioId: run.scenarioId, environmentId: run.environmentId }),
    });
    const body = await res.json().catch(() => undefined);
    setBusy(null);
    if (!res.ok) return setError(body?.error?.message ?? t("actions.rerunFailed"));
    router.push(`/w/${slug}/runs/${body.id}`);
  }

  async function rerunFailed() {
    if (!run.groupRunId) return;
    setBusy("rerunFailed");
    setError(undefined);
    const res = await fetch(`/api/w/${slug}/groups/${run.groupRunId}/rerun-failed`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } });
    const body = await res.json().catch(() => undefined);
    setBusy(null);
    if (!res.ok) return setError(body?.error?.message ?? t("actions.rerunFailed"));
    const first = body?.runIds?.[0];
    if (first) router.push(`/w/${slug}/runs/${first}`);
  }

  const canRerun = can.create && !active && run.scenarioId !== null && run.environmentId !== null;
  const rerunHint = !can.create ? t("actions.viewerHint") : run.trigger === "test" ? t("actions.testRunHint") : !run.scenarioId || !run.environmentId ? t("actions.deletedHint") : undefined;
  const showRerunFailed = run.groupRunId !== null && !active && run.status !== "passed";

  return (
    <section className="rounded-card border border-border bg-bg-surface p-6 shadow-e1" aria-labelledby="run-title">
      <div className="flex flex-wrap items-start gap-4">
        <span className={`flex size-12 shrink-0 items-center justify-center rounded-item border ${infra ? "border-border-strong bg-error-soft text-error" : `border-current/20 ${STATUS_SOFT[run.status]} ${STATUS_TEXT[run.status]}`}`}>
          <SwapIn value={run.status}>
            <StatusIcon status={run.status} width={22} height={22} />
          </SwapIn>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 id="run-title" className="text-title-lg">
              <SwapIn value={run.status}>
                <span className={STATUS_TEXT[run.status]}>{t(`status.${run.status}`)}</span>
              </SwapIn>
              <span className="mx-2 text-text-muted" aria-hidden="true">·</span>
              {run.trigger === "test" ? t("testRunTitle") : run.scenarioName}
            </h2>
            {infra && (
              <span className="inline-flex h-6 items-center gap-1 rounded-tag bg-error-soft px-2 text-meta font-semibold text-error">
                <InfraIcon width={13} height={13} />
                {t("infraBadge")}
              </span>
            )}
            {run.passedAfterRetry && (
              <span className="inline-flex h-6 items-center gap-1 rounded-tag bg-pass-soft px-2 text-meta font-semibold text-pass">
                <RerunIcon width={13} height={13} />
                {t("passedAfterRetry")}
              </span>
            )}
            {run.warningCount > 0 && (
              <span className="inline-flex h-6 items-center gap-1 rounded-tag bg-timed-out-soft px-2 text-meta font-semibold text-warn">
                <AlertIcon width={13} height={13} />
                {t("warningCount", { count: run.warningCount })}
              </span>
            )}
            {run.cancelRequested && (
              <span className="inline-flex h-6 items-center gap-1 rounded-tag bg-cancelled-soft px-2 text-meta font-semibold text-cancelled" role="status">
                <StopIcon width={13} height={13} />
                {t("cancelRequestedBadge")}
              </span>
            )}
          </div>
          <p className="mt-1 text-text-secondary" aria-live="polite">
            {summary}
            {run.status === "running" && live && <span className="text-text-muted"> · {t("live.updating")}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active && can.cancel && (
            <Button variant="secondary" disabled={busy !== null || run.cancelRequested} onClick={() => void cancel()}>
              <StopIcon />
              {run.cancelRequested ? t("actions.cancelRequested") : busy === "cancel" ? t("actions.cancelling") : t("actions.cancel")}
            </Button>
          )}
          {showRerunFailed && can.create && (
            <Button variant="secondary" disabled={!rerunFailedAvailable || busy !== null} title={rerunFailedAvailable ? undefined : t("actions.comingHint")} onClick={() => void rerunFailed()}>
              <RerunFailedIcon />
              {t("actions.rerunFailedOnly")}
            </Button>
          )}
          {!active && (
            <Button variant={infra ? "primary" : "secondary"} disabled={!canRerun || busy !== null} title={rerunHint} onClick={() => void rerun()}>
              <RerunIcon />
              {busy === "rerun" ? t("actions.starting") : t("actions.rerun")}
            </Button>
          )}
          {!active && !infra && (
            <Button disabled title={t("diagnose.later")} aria-describedby="diagnose-hint">
              <SparklesIcon />
              {t("diagnose.title")}
            </Button>
          )}
          <span id="diagnose-hint" className="sr-only">
            {t("diagnose.later")}
          </span>
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {active && total > 0 && <Progress run={run} runningIndex={runningIndex} passed={passed} t={t} />}
      {run.errorMessage && !problem && (
        <p className="mt-4 rounded-control border border-border bg-bg-subtle px-3 py-2 font-mono text-code text-text-secondary">
          {run.errorCode && <span className="font-semibold">{run.errorCode}: </span>}
          {run.errorMessage}
        </p>
      )}
      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-5 md:grid-cols-3 xl:grid-cols-6">
        <Meta icon={<LayersIcon />} label={t("meta.environment")} value={run.environmentName} title={run.baseUrl} />
        <Meta icon={<UserIcon />} label={t("meta.startedBy")} value={startedBy} />
        <Meta
          icon={<ClockIcon />}
          label={active ? t("meta.elapsed") : t("meta.duration")}
          value={durationMs === null ? "—" : `${formatDuration(durationMs)}${run.status === "cancelled" || run.status === "timed_out" || run.status === "error" ? ` (${t("meta.stopped")})` : ""}`}
          mono
        />
        {run.location === "desktop" ? (
          <Meta icon={<ServerIcon />} label={t("meta.runner")} value={t("meta.desktop", { label: run.deviceLabel ?? "—" })} title={t("meta.desktopTitle")} />
        ) : (
          <Meta icon={<ServerIcon />} label={t("meta.runner")} value={run.workerId ?? t("meta.serverWorker")} title={t("meta.serverWorker")} />
        )}
        <Meta icon={<CalendarIcon />} label={t("meta.started")} value={run.startedAt && now !== null ? format.dateTime(new Date(run.startedAt), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"} mono />
        <Meta icon={<PackageIcon />} label={t("meta.versions")} value={`${run.runnerVersion ?? "—"} / ${run.browserVersion ?? "—"}`} mono />
      </dl>
    </section>
  );
}

function Progress({ run, runningIndex, passed, t }: { run: RunDetail; runningIndex: number; passed: number; t: T }) {
  const total = run.steps.length;
  const current = run.status === "running" ? Math.min(runningIndex === -1 ? total : runningIndex + 1, total) : 0;
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between text-meta">
        <span className="font-semibold">
          <PopIn value={current}>{run.status === "running" ? t("progress.step", { step: current, total }) : t("progress.waiting")}</PopIn>
        </span>
        <span className="text-text-muted">{t("progress.passed", { count: passed })}</span>
      </div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={run.steps.filter((s) => s.result).length} aria-label={t("steps.title")} className="mt-2 flex gap-1">
        {run.steps.map((s) => {
          const status = stepStatus(s, run, runningIndex);
          const fill = status === "passed" ? "bg-pass" : status === "running" ? "bg-running" : status === "queued" ? "bg-border" : PROBLEM.has(status) ? (status === "error" ? "bg-error" : "bg-fail") : "bg-border-strong";
          return <span key={s.index} className={`h-1.5 flex-1 rounded-full ${fill}`} />;
        })}
      </div>
    </div>
  );
}

function Meta({ icon, label, value, mono, title }: { icon: ReactNode; label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-meta text-text-muted">{label}</dt>
      <dd className={`mt-0.5 flex items-center gap-1.5 truncate ${mono ? "font-mono text-code" : "font-semibold"}`} title={title}>
        <span className="shrink-0 text-text-muted">{icon}</span>
        <span className="truncate">{value}</span>
      </dd>
    </div>
  );
}

// --- Steps -------------------------------------------------------------------------------

function Steps({ run, runningIndex, t }: { run: RunDetail; runningIndex: number; t: T }) {
  const counts = new Map<StepDisplayStatus, number>();
  for (const s of run.steps) {
    const status = stepStatus(s, run, runningIndex);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const order: StepDisplayStatus[] = ["passed", "warning", "failed", "error", "timed_out", "cancelled", "running", "queued", "skipped", "notRun"];
  const logs = run.artifacts.filter((a) => a.kind === "log");
  const traces = run.artifacts.filter((a) => a.kind === "trace");
  return (
    <section className="flex flex-col overflow-hidden rounded-card border border-border bg-bg-surface shadow-e1" aria-labelledby="steps-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <h2 id="steps-title" className="text-title-sm">
          {t("steps.title")}
        </h2>
        <ul className="flex flex-wrap gap-3 text-meta">
          {order
            .filter((s) => counts.get(s))
            .map((s) => (
              <li key={s} className={`flex items-center gap-1 ${STATUS_TEXT[s]}`}>
                <StatusIcon status={s} width={14} height={14} />
                <span className="text-text-secondary">{t(`steps.count.${s}`, { count: counts.get(s)! })}</span>
              </li>
            ))}
        </ul>
      </div>
      {run.steps.length === 0 && <p className="px-6 py-8 text-center text-text-muted">{t("steps.none")}</p>}
      <ol>
        {run.steps.map((step) => (
          <StepRow key={step.index} run={run} step={step} status={stepStatus(step, run, runningIndex)} shots={run.artifacts.filter((a) => a.kind === "screenshot" && a.stepIndex === step.index)} diff={run.artifacts.find((a) => a.kind === "visual_diff" && a.stepIndex === step.index)} />
        ))}
      </ol>
      {(logs.length > 0 || traces.length > 0) && (
        <div className="border-t border-border">
          {logs.map((a) => (
            <LogRow key={a.id} artifact={a} t={t} />
          ))}
          {traces.map((a) => (
            <div key={a.id} className="flex items-center gap-3 border-b border-border px-6 py-3 last:border-b-0">
              <FileIcon className="text-text-muted" />
              <span className="w-24 font-semibold">{t("files.trace")}</span>
              <a href={a.url} className="font-mono text-code underline underline-offset-2" download>
                {a.name} · {formatBytes(a.sizeBytes)}
              </a>
              <span className="ml-auto hidden text-meta text-text-muted lg:inline">{t("files.traceHint")}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function StepRow({ run, step, status, shots, diff }: { run: RunDetail; step: RunStepView; status: StepDisplayStatus; shots: ArtifactView[]; diff?: ArtifactView }) {
  const t = useTranslations("runs");
  const actionLabel = useActionLabel();
  const detailId = useId();
  const problem = PROBLEM.has(status);
  // Warnings and optional-step skips carry a message worth showing.
  const noted = (status === "warning" || status === "skipped") && Boolean(step.result?.errorMessage);
  const optionalSkip = status === "skipped" && Boolean(step.result?.errorMessage?.startsWith("[optional]"));
  const visual = step.result?.visual ?? null;
  const hasDetail = problem || noted || shots.length > 0 || Boolean(step.result?.possibleDuplicate) || visual !== null;
  const [open, setOpen] = useState(problem || status === "warning");
  useEffect(() => {
    if (problem) setOpen(true);
  }, [problem]);
  const r = step.result;
  const infra = status === "error";
  const right =
    status === "running" ? t("steps.running") : status === "queued" ? t("steps.queued") : status === "notRun" || (status === "skipped" && !optionalSkip) ? t("steps.notRun") : optionalSkip ? t("steps.skippedOptional") : r ? formatDuration(r.durationMs) : "—";
  // A soft wash per status, no left edge (A′ Ink: the badge and icon carry the status). Only a failed check is red; infrastructure, stops and the running step each have their own tone (s-2, s-4).
  const tone =
    status === "failed"
      ? "bg-fail-soft"
      : infra
        ? "bg-error-soft/70"
        : status === "cancelled"
          ? "bg-cancelled-soft"
          : status === "timed_out"
            ? "bg-timed-out-soft"
            : status === "running"
              ? "bg-running-soft"
              : status === "warning"
                ? "bg-timed-out-soft/60"
              : "";
  const failed = status === "failed";

  const rowContent = (
    <>
      <span className={STATUS_TEXT[status]}>
        <StatusIcon status={status} width={18} height={18} />
      </span>
      <span className="w-6 font-mono text-code text-text-muted">{stepNumber(step.index)}</span>
      <span className={`w-32 shrink-0 truncate ${problem ? "font-semibold" : ""}`}>{step.name || actionLabel(step.action)}</span>
      {(status === "failed" || status === "error" || status === "cancelled" || status === "timed_out") && <StatusBadge status={status} label={t(`stepStatus.${status}`)} />}
      {status === "warning" && <StatusBadge status="warning" label={t("stepStatus.warning")} />}
      {optionalSkip && <StatusBadge status="skipped" label={t("stepStatus.skippedOptional")} />}
      {visual && <VisualBadge visual={visual} />}
      <span className="min-w-0 flex-1 truncate text-left font-mono text-code text-text-secondary">{[step.selector ?? step.url, step.value ?? step.expected].filter((v) => v !== undefined && v !== "").join(" → ")}</span>
      {r && r.attempts > 1 && (
        <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-current/30 px-2 text-meta font-semibold">
          <RerunIcon width={12} height={12} />
          {t("steps.attempt", { attempts: r.attempts, max: Math.max(step.maxAttempts, r.attempts) })}
        </span>
      )}
      <span className={`w-20 shrink-0 text-right font-mono text-code ${problem ? STATUS_TEXT[status] : status === "running" ? "text-running" : "text-text-muted"}`}>{right}</span>
      {hasDetail ? <ChevronIcon className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-90" : ""}`} /> : <span className="w-4 shrink-0" />}
    </>
  );

  return (
    <li className={`border-b border-border last:border-b-0 ${tone}`}>
      {hasDetail ? (
        <button type="button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-6 py-3 text-left hover:bg-bg-subtle/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
          {rowContent}
          <span className="sr-only">{t(`stepStatus.${status}`)}</span>
        </button>
      ) : (
        <div className="flex items-center gap-3 px-6 py-3">
          {rowContent}
          <span className="sr-only">{t(`stepStatus.${status}`)}</span>
        </div>
      )}
      {hasDetail && open && (
        <div id={detailId} className="flex flex-col gap-3 px-6 pb-4 pl-[76px] lg:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {r && (r.expected !== null || r.actual !== null) && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-control border border-border bg-bg-surface p-3">
                  <p className="text-label uppercase tracking-wider text-text-muted">{t("steps.expected")}</p>
                  <p className="mt-1 font-mono text-code break-words">{r.expected ?? "—"}</p>
                </div>
                <div className={`rounded-control border bg-bg-surface p-3 ${failed ? "border-fail/30 text-fail" : "border-border"}`}>
                  <p className="text-label uppercase tracking-wider">{t("steps.actual")}</p>
                  <p className="mt-1 font-mono text-code break-words">{r.actual ?? "—"}</p>
                </div>
              </div>
            )}
            {r?.errorMessage && (
              <p className={`rounded-control border bg-bg-surface px-3 py-2 font-mono text-code break-words whitespace-pre-wrap ${failed ? "border-fail/30 text-fail" : status === "warning" ? "border-warn/30 text-warn" : "border-border-strong text-text-primary"}`}>
                {hasVisualWarningText(r.visual) ? (
                  <VisualWarningText visual={r.visual} />
                ) : (
                  <>
                    {r.errorCode && <span className="font-semibold">{r.errorCode}: </span>}
                    {r.errorMessage}
                  </>
                )}
                {r.attempts > 0 && <span className="mt-1 block text-text-muted">{t("steps.attempts", { count: r.attempts })}</span>}
              </p>
            )}
            {r?.possibleDuplicate && (
              <p className="flex items-start gap-2 rounded-control border border-warn/30 bg-timed-out-soft px-3 py-2 text-body">
                <AlertIcon className="mt-0.5 shrink-0 text-warn" />
                <span>
                  <span className="font-semibold">{t("steps.duplicateTitle")}</span> {t("steps.duplicateBody")}
                </span>
              </p>
            )}
            {visual && <VisualDetail visual={visual} shot={shots.at(-1)} diff={diff} />}
            {infra && <InfraHelp run={run} step={step} />}
          </div>
          {shots.length > 0 && (
            <div className="flex shrink-0 flex-col gap-2">
              {shots.map((shot) => (
                <a key={shot.id} href={shot.url} target="_blank" rel="noreferrer" className="group flex flex-col gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API response, not a static asset */}
                  <img src={shot.url} alt={t("shots.alt", { step: step.index + 1, name: shot.name })} loading="lazy" className={`h-36 w-56 rounded-control border object-cover object-top group-hover:shadow-e2 ${failed ? "border-fail/50" : "border-border"}`} />
                  <span className="truncate font-mono text-code-sm text-text-muted">{shot.name}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Run-level codes where the machine or browser went away (stage 3 contract section 4). */
const LOST = new Set(["worker_lost", "worker_shutdown", "browser_crashed", "browser_launch_failed"]);

function InfraHelp({ run, step }: { run: RunDetail; step: RunStepView }) {
  const t = useTranslations("runs.infra");
  const later = run.steps.filter((s) => s.index > step.index && (!s.result || s.result.status === "skipped")).length;
  // Only say the machine was lost when that is what was recorded; other step errors (e.g. an action this
  // runner doesn't support) are explained by their own message above.
  const lost = step.result?.errorCode === "infra" || LOST.has(run.errorCode ?? "");
  return (
    <div className="flex flex-col gap-2">
      <p>{lost ? (later > 0 ? t("explainWithLater", { count: later }) : t("explain")) : later > 0 ? t("stepErrorWithLater", { count: later }) : t("stepError")}</p>
      {lost && (
        <>
          <p className="text-label uppercase tracking-wider text-text-muted">{t("whatToDo")}</p>
          <ol className="list-decimal space-y-1 pl-5 text-text-secondary">
            <li>{t("todoRerun")}</li>
            <li>{t("todoWorker")}</li>
          </ol>
        </>
      )}
    </div>
  );
}

function LogRow({ artifact, t }: { artifact: ArtifactView; t: T }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const lines = text?.split("\n").filter(Boolean) ?? [];
  const errors = lines.filter((l) => /\berror:/.test(l)).length;
  const warnings = lines.filter((l) => /\bwarn:/.test(l)).length;
  return (
    <details
      className="group border-b border-border last:border-b-0"
      onToggle={(e) => {
        if (!(e.currentTarget as HTMLDetailsElement).open || text !== null) return;
        fetch(artifact.url)
          .then((res) => (res.ok ? res.text() : Promise.reject(new Error(res.statusText))))
          .then(setText, () => setFailed(true));
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-6 py-3 hover:bg-bg-subtle/60 [&::-webkit-details-marker]:hidden">
        <ChevronIcon className="shrink-0 text-text-muted transition-transform group-open:rotate-90" />
        <TerminalIcon className="text-text-muted" />
        <span className="w-24 font-semibold">{t("files.console")}</span>
        <span className={`font-mono text-code ${errors ? "text-fail" : "text-text-secondary"}`}>
          {text === null ? `${artifact.name} · ${formatBytes(artifact.sizeBytes)}` : t("files.logCounts", { errors, warnings })}
        </span>
        <a href={artifact.url} download onClick={(e) => e.stopPropagation()} className="ml-auto text-meta font-semibold underline underline-offset-2">
          {t("files.download")}
        </a>
      </summary>
      <div className="px-6 pb-4">
        {failed ? (
          <Alert>{t("files.logFailed")}</Alert>
        ) : text === null ? (
          <p className="text-text-muted">{t("files.loading")}</p>
        ) : (
          <pre className="max-h-80 overflow-auto rounded-control border border-border bg-bg-subtle p-3 font-mono text-code-sm whitespace-pre-wrap">{lines.slice(0, 500).join("\n")}</pre>
        )}
      </div>
    </details>
  );
}

// --- Side column -------------------------------------------------------------------------

function Changes({ slug, run, view }: { slug: string; run: RunDetail; view: RunChangesView }) {
  const t = useTranslations("runs.changes");
  const format = useFormatter();
  const hydrated = useHydrated();
  const actionLabel = useActionLabel();
  const tRuns = useTranslations("runs");
  const step = (index: number) => {
    const s = run.steps[index];
    return s ? `${stepNumber(index)} ${actionLabel(s.action)}` : stepNumber(index);
  };
  const statusWord = (s: string) => (s === "notRun" ? tRuns("stepStatus.notRun") : tRuns(`stepStatus.${s}` as never));
  const item = (c: RunChange): { title: string; detail: string; badge?: string; tone?: string } => {
    switch (c.kind) {
      case "stepsEdited":
        return { title: t("stepsEdited"), detail: t("stepsEditedDetail", { added: c.added, removed: c.removed, edited: c.edited }), badge: t("badgeEdited") };
      case "outcome":
        return { title: t("outcome", { step: step(c.index), status: statusWord(c.status) }), detail: t("outcomeWas", { status: statusWord(c.previous) }), badge: t("badgeFirst"), tone: "text-fail" };
      case "slowStep":
        return {
          title: t("slowStep", { step: step(c.index), duration: formatDuration(c.durationMs) }),
          detail: t("usual", { duration: formatDuration(c.usualMs) }),
          badge: `×${(c.durationMs / Math.max(c.usualMs, 1)).toFixed(1)}`,
          tone: "text-timed-out",
        };
      case "baseUrl":
        return { title: t("baseUrl"), detail: `${c.from} → ${c.to}`, badge: t("badgeEnv") };
      case "runnerVersion":
        return { title: t("runnerVersion"), detail: `${c.from} → ${c.to}`, badge: t("badgeVersion") };
      case "browserVersion":
        return { title: t("browserVersion"), detail: `${c.from} → ${c.to}`, badge: t("badgeVersion") };
    }
  };
  return (
    <section className="overflow-hidden rounded-card border border-border bg-bg-surface shadow-e1" aria-labelledby="changes-title">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <HistoryIcon className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 id="changes-title" className="text-title-sm">
            {t("title")}
          </h2>
          {view.baseline ? (
            <p className="text-meta text-text-muted">
              {t("vs", { id: shortRunId(view.baseline.id), when: view.baseline.finishedAt && hydrated ? format.relativeTime(new Date(view.baseline.finishedAt), Date.now()) : "…" })}
            </p>
          ) : null}
        </div>
        {view.baseline && (
          <Link href={`/w/${slug}/runs/${view.baseline.id}`} className="shrink-0 text-meta font-semibold underline-offset-2 hover:underline">
            {t("openBaseline")} →
          </Link>
        )}
      </div>
      {!view.baseline ? (
        <p className="px-5 py-4 text-text-muted">{t("noBaseline")}</p>
      ) : view.changes.length === 0 ? (
        <p className="px-5 py-4 text-text-muted">{t("none")}</p>
      ) : (
        <ul>
          {view.changes.map((c, i) => {
            const v = item(c);
            return (
              <li key={i} className="flex items-start gap-3 border-b border-border px-5 py-3 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className={`font-mono text-code font-semibold ${v.tone ?? ""}`}>{v.title}</p>
                  <p className="truncate text-meta text-text-muted" title={v.detail}>
                    {v.detail}
                  </p>
                </div>
                {v.badge && <span className={`shrink-0 rounded-tag bg-bg-subtle px-1.5 py-0.5 font-mono text-code-sm ${v.tone ?? "text-text-secondary"}`}>{v.badge}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Recording({ artifact, t }: { artifact: ArtifactView; t: T }) {
  return (
    <section className="overflow-hidden rounded-card border border-border bg-bg-surface shadow-e1" aria-label={t("recording.title")}>
      <div className="flex items-center justify-between px-5 py-4">
        <h2 className="text-title-sm">{t("recording.title")}</h2>
        <span className="font-mono text-code-sm text-text-muted">webm · {formatBytes(artifact.sizeBytes)}</span>
      </div>
      <video src={artifact.url} controls preload="metadata" className="aspect-video w-full bg-black" />
      <p className="px-5 py-3 text-meta text-text-muted">{t("recording.warning")}</p>
    </section>
  );
}

function Screenshots({ run, shots, t }: { run: RunDetail; shots: ArtifactView[]; t: T }) {
  return (
    <section aria-labelledby="shots-title">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 id="shots-title" className="text-title-sm">
          {t("shots.title")}
        </h2>
        <span className="text-meta text-text-muted">{t("shots.count", { count: shots.length })}</span>
      </div>
      <ul className="grid grid-cols-3 gap-3">
        {shots.map((shot) => {
          const step = shot.stepIndex === null ? undefined : run.steps[shot.stepIndex];
          const status = step?.result?.status ?? "passed";
          const bad = status === "failed";
          return (
            <li key={shot.id}>
              <a href={shot.url} target="_blank" rel="noreferrer" className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API response */}
                <img src={shot.url} alt={t("shots.alt", { step: (shot.stepIndex ?? 0) + 1, name: shot.name })} loading="lazy" className={`aspect-[4/3] w-full rounded-control border object-cover object-top ${bad ? "border-2 border-fail" : "border-border"}`} />
                <span className={`flex items-center gap-1 font-mono text-code-sm ${STATUS_TEXT[status]}`}>
                  <StatusIcon status={status} width={12} height={12} />
                  {shot.stepIndex === null ? shot.name : t("shots.step", { step: stepNumber(shot.stepIndex) })}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RunnerCard({ run, t }: { run: RunDetail; t: T }) {
  const wait = run.startedAt ? new Date(run.startedAt).getTime() - new Date(run.queuedAt).getTime() : null;
  const rows: [string, string][] = [
    [t("runner.worker"), run.workerId ? `${run.workerId} · ${t("meta.serverWorker")}` : run.status === "queued" ? t("runner.notClaimed") : t("meta.serverWorker")],
    [t("runner.browser"), run.browserVersion ?? "—"],
    [t("runner.queueWait"), wait === null ? t("runner.waiting") : formatDuration(Math.max(0, wait))],
  ];
  return (
    <section className="rounded-card border border-border bg-bg-surface p-5 shadow-e1" aria-labelledby="runner-title">
      <h2 id="runner-title" className="text-title-sm">
        {t("runner.title")}
      </h2>
      <dl className="mt-3 flex flex-col gap-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="text-text-muted">{k}</dt>
            <dd className="truncate font-mono text-code">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.ceil(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
