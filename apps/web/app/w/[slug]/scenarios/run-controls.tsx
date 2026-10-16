"use client";

import { runOptionsSchema, type Step } from "@defe2end/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Alert, Button, buttonClass, Dialog } from "../../../../components/ui";
import { endpointUrl } from "../../../../lib/run-endpoints";
import type { RunSummary } from "../../../../lib/run-read";
import { formatDuration, shortRunId, STATUS_FILL } from "../runs/run-ui";
import { RefreshWhileActive } from "../runs/runs-live";
import { useHydrated } from "../runs/use-hydrated";

// Scenario page ↔ runs (ap-1): the "Test run" dialog, running the saved version, and the run history strip.

/** True once the runner's `video` run option is in the shared schema (contract section 6). */
const VIDEO_OPTION = runOptionsSchema.safeParse({ video: true }).success;

export interface EnvironmentOption {
  id: string;
  name: string;
  baseUrl: string;
}

/**
 * `test`: runs the editor's current (maybe unsaved) steps, no scenario attached. `saved`: a normal run of the
 * saved scenario. The result opens from the link, so the editor and its unsaved changes stay put.
 */
export function StartRunDialog({
  slug,
  mode,
  scenarioId,
  steps,
  environments,
  defaultEnvironmentId,
  onStarted,
  onClose,
}: {
  slug: string;
  mode: "test" | "saved";
  scenarioId: string;
  steps: Step[];
  environments: EnvironmentOption[];
  defaultEnvironmentId?: string;
  /** Told the new run's id (the editor shows its last test run). */
  onStarted?: (runId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("scenarios.run");
  const router = useRouter();
  const [environmentId, setEnvironmentId] = useState(defaultEnvironmentId ?? environments[0]?.id ?? "");
  const [video, setVideo] = useState(false);
  const placement = useRunPlacement();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // variable_missing: the personal variables to fill in, with a link to where they're set.
  const [missingKeys, setMissingKeys] = useState<string[]>();
  const [started, setStarted] = useState<string>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    setMissingKeys(undefined);
    const options = video ? { video: true } : {};
    const where = placement.location === "desktop" ? { location: "desktop", ...(placement.deviceId ? { deviceId: placement.deviceId } : {}) } : {};
    const res = await fetch(mode === "test" ? endpointUrl(slug, "testRun") : `/api/w/${slug}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      // A test run names the editor's saved scenario only to be found as its "last test run".
      body: JSON.stringify(mode === "test" ? { scenarioId, environmentId, steps, options, ...where } : { scenarioId, environmentId, options, ...where }),
    });
    const body = await res.json().catch(() => undefined);
    setPending(false);
    if (!res.ok && body?.error?.code === "variable_missing") return setMissingKeys(body.error.keys ?? []);
    if (!res.ok) return setError(runErrorMessage(t, body?.error) ?? body?.error?.message ?? t("failed"));
    setStarted(body.id);
    onStarted?.(body.id);
    router.refresh();
  }

  if (started) {
    return (
      <Dialog
        title={mode === "test" ? t("testStarted") : t("started")}
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t("close")}
            </Button>
            <Link href={`/w/${slug}/runs/${started}`} className={buttonClass("primary")}>
              {t("openResult")}
            </Link>
          </>
        }
      >
        <p className="text-text-secondary">{mode === "test" ? t("testStartedBody") : t("startedBody")}</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={mode === "test" ? t("testTitle") : t("title")}
      onClose={() => !pending && onClose()}
      onSubmit={onSubmit}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={pending || !environmentId || (placement.location === "desktop" && !placement.deviceId)}>
            {pending ? t("starting") : mode === "test" ? t("startTest") : t("start")}
          </Button>
        </>
      }
    >
      <p className="text-text-secondary">{mode === "test" ? t("testBody", { count: steps.length }) : t("body")}</p>
      <PlacementField placement={placement} />
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-meta font-semibold">{t("environment")}</legend>
        {environments.map((env) => (
          <label key={env.id} className="flex cursor-pointer items-center gap-2 rounded-control border border-border px-3 py-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
            <input type="radio" name="environmentId" value={env.id} checked={environmentId === env.id} onChange={() => setEnvironmentId(env.id)} className="accent-[var(--color-accent)]" />
            <span className="font-semibold">{env.name}</span>
            <span className="truncate font-mono text-code text-text-muted">{env.baseUrl}</span>
          </label>
        ))}
      </fieldset>
      {VIDEO_OPTION && (
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} className="mt-1 accent-[var(--color-accent)]" />
          <span>
            <span className="font-semibold">{t("video")}</span>
            <span className="block text-meta text-warn">{t("videoWarning")}</span>
          </span>
        </label>
      )}
      {error && <Alert>{error}</Alert>}
      {missingKeys && (
        <div role="alert" className="flex flex-col gap-2 rounded-control border border-fail/30 bg-fail-soft px-3 py-2 text-meta text-fail">
          <p>{t("errors.variableMissing")}</p>
          <p className="flex flex-wrap gap-1">
            {missingKeys.map((k) => (
              <code key={k} className="rounded-tag border border-fail/30 bg-bg-surface px-1.5 font-mono text-code">
                {k}
              </code>
            ))}
          </p>
          <Link href={`/w/${slug}/settings/sites`} className="self-start font-semibold underline underline-offset-2">
            {t("errors.setMyValue")} →
          </Link>
        </div>
      )}
    </Dialog>
  );
}

interface DeviceOption {
  id: string;
  label: string;
  online: boolean;
}

type Placement = ReturnType<typeof useRunPlacement>;

/**
 * Run location (stage 4 contract section 4.1). PC is the default only inside the desktop app (its preload
 * exposes `window.defe2end`) and only when one of the caller's devices is online; otherwise the server.
 */
function useRunPlacement() {
  const [devices, setDevices] = useState<DeviceOption[] | null>(null);
  const [location, setLocation] = useState<"server" | "desktop">("server");
  const [deviceId, setDeviceId] = useState<string>();
  useEffect(() => {
    let alive = true;
    fetch("/api/desktop/devices")
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .catch(() => ({ items: [] }))
      .then((body: { items: DeviceOption[] }) => {
        if (!alive) return;
        const online = body.items.filter((d) => d.online);
        setDevices(online);
        setDeviceId(online[0]?.id);
        if (online.length > 0 && "defe2end" in window) setLocation("desktop");
      });
    return () => {
      alive = false;
    };
  }, []);
  return { devices, location, setLocation, deviceId, setDeviceId };
}

function PlacementField({ placement }: { placement: Placement }) {
  const t = useTranslations("scenarios.run");
  const { devices, location, setLocation, deviceId, setDeviceId } = placement;
  const none = devices !== null && devices.length === 0;
  const option = "flex cursor-pointer items-center gap-2 rounded-control border border-border px-3 py-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60";
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-meta font-semibold">{t("location")}</legend>
      <label className={option}>
        <input type="radio" name="location" checked={location === "server"} onChange={() => setLocation("server")} className="accent-[var(--color-accent)]" />
        <span className="font-semibold">{t("locationServer")}</span>
      </label>
      <label className={option}>
        <input type="radio" name="location" checked={location === "desktop"} disabled={devices === null || none} onChange={() => setLocation("desktop")} className="accent-[var(--color-accent)]" />
        <span className="font-semibold">{t("locationDesktop")}</span>
        {devices === null && <span className="text-meta text-text-muted">{t("devicesLoading")}</span>}
      </label>
      {none && <p className="text-meta text-text-muted">{t("noDevice")}</p>}
      {location === "desktop" && devices && devices.length > 1 && (
        <label className="flex items-center gap-2 text-meta">
          <span className="font-semibold">{t("device")}</span>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="rounded-control border border-border bg-bg px-2 py-1">
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </fieldset>
  );
}

/** Desktop and login-session refusals in words people act on; null for anything else. */
export function runErrorMessage(t: (key: any, values?: any) => string, error: { code?: string; missing?: string[] } | undefined): string | null {
  switch (error?.code) {
    case "desktop_not_connected":
      return t("errors.desktopNotConnected");
    case "app_update_required":
      return t("errors.appUpdate", { missing: (error.missing ?? []).join(", ") });
    case "auth_session_missing":
      return t("errors.authSessionMissing");
    default:
      return null;
  }
}

/** ap-1 footer: the last 24 runs (oldest left), counts and median duration, link to all runs. */
/**
 * The scenario's "Runs" section under the editor: title with the run button and summary, the editor's last
 * test run, then the history strip (test runs stay out of it). Same white surface and 24px sides as the editor.
 */
export function RunHistory({ slug, scenarioId, runs, action, lastTestRun }: { slug: string; scenarioId: string; runs: RunSummary[]; action?: ReactNode; lastTestRun?: ReactNode }) {
  const t = useTranslations("scenarios.history");
  const tRuns = useTranslations("runs");
  const format = useFormatter();
  const hydrated = useHydrated();
  const SLOTS = 24;
  const count = (s: RunSummary["status"]) => runs.filter((r) => r.status === s).length;
  const passed = count("passed");
  const failed = count("failed");
  const other = runs.length - passed - failed;
  const durations = runs.flatMap((r) => (r.durationMs === null ? [] : [r.durationMs])).sort((a, b) => a - b);
  const p50 = durations.length ? durations[Math.floor((durations.length - 1) / 2)]! : null;
  const latest = runs.at(-1);
  const active = runs.some((r) => r.status === "queued" || r.status === "running");
  const day = (iso: string) => (hydrated ? format.dateTime(new Date(iso), { month: "short", day: "numeric" }) : "");

  return (
    <section aria-label={t("section")} className="flex flex-col gap-3 border-t border-border px-6 py-4">
      {active && <RefreshWhileActive />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-label uppercase tracking-wider text-text-muted">{t("section")}</h3>
        <div className="flex flex-wrap items-center gap-4 text-meta">
          {runs.length > 0 && (
            <>
              <span className="text-pass">{t("passed", { count: passed })}</span>
              <span className="text-fail">{t("failed", { count: failed })}</span>
              {other > 0 && <span className="text-text-secondary">{t("other", { count: other })}</span>}
              {p50 !== null && <span className="font-mono text-text-secondary">p50 {formatDuration(p50)}</span>}
            </>
          )}
          {action}
        </div>
      </div>
      {lastTestRun}
      <div className="flex flex-col gap-1.5">
      <p className="text-meta text-text-muted">
        {t("title")} · {t("last", { count: SLOTS })} — {t("testRunsExcluded")}
      </p>
      <ol className="flex gap-1" aria-label={t("title")}>
        {Array.from({ length: SLOTS - runs.length }, (_, i) => (
          <li key={`empty-${i}`} className="h-6 flex-1 rounded-[3px] bg-border/60" aria-hidden="true" />
        ))}
        {runs.map((r) => {
          const when = hydrated ? ` · ${format.dateTime(new Date(r.queuedAt), { dateStyle: "medium", timeStyle: "short" })}` : "";
          const label = `${tRuns(`status.${r.status}`)} · ${r.environmentName}${when}${r.durationMs === null ? "" : ` · ${formatDuration(r.durationMs)}`}`;
          return (
            <li key={r.id} className="flex flex-1">
              <Link
                href={`/w/${slug}/runs/${r.id}`}
                aria-label={label}
                title={label}
                className={`h-6 w-full rounded-[3px] ${STATUS_FILL[r.status]} ${r.status === "running" ? "motion-safe:animate-pulse" : ""} ${r.id === latest?.id ? "ring-2 ring-text-muted/40 ring-offset-1" : ""} hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
              />
            </li>
          );
        })}
      </ol>
      <div className="flex items-center justify-between gap-3 text-meta text-text-muted">
        {runs.length === 0 ? (
          <span>{t("none")}</span>
        ) : (
          <>
            <span className="font-mono">{day(runs[0]!.queuedAt)}</span>
            <span className="flex items-center gap-4">
              <span className="font-mono">
                {day(latest!.queuedAt)} · #{shortRunId(latest!.id)}
              </span>
              <Link href={`/w/${slug}/runs?scenarioId=${scenarioId}`} className="font-semibold text-text-primary underline-offset-2 hover:underline">
                {t("allRuns")} →
              </Link>
            </span>
          </>
        )}
      </div>
      </div>
    </section>
  );
}
