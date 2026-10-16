"use client";

import { stepSchema, type Step } from "@defe2end/shared";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { z } from "zod";
import { Alert, Button, inputClass } from "../../../../components/ui";
import { newStepId } from "../../../../lib/scenario-helpers";
import { claimForRecorder } from "../side-browser-owner";

// Recording in the desktop app (stage 4 contract section 7): the web UI reserves the side browser's area and
// sends its bounds, starts and stops recording, shows the `RecordingResult` the app sends, and puts the steps
// into the editor (saved with the scenario API as usual). Only inside the app: the preload exposes
// `window.defe2end`; in a plain browser none of this renders.

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The part of the app's preload API this panel uses (apps/desktop/src/preload.ts). */
export interface DesktopBridge {
  sideBrowser: {
    open(url: string | undefined, bounds: Bounds): Promise<unknown>;
    close(): Promise<unknown>;
    setBounds(bounds: Bounds): Promise<unknown>;
    navigate(url: string): Promise<unknown>;
    setDragging(dragging: boolean): Promise<unknown>;
    setDevice(device: "desktop" | "mobile"): Promise<unknown>;
    saveSession(target: { workspaceId: string; environmentId: string }): Promise<unknown>;
  };
  recorder: {
    start(): Promise<unknown>;
    stop(): Promise<unknown>;
    discard(eventIds: string[]): Promise<unknown>;
    onResult(listener: (result: unknown) => void): () => void;
    onCheckRequested(listener: (request: unknown) => void): () => void;
  };
  /** Stage 6 AI browser tools; absent in older apps. */
  mcp?: {
    onOpenRequested?(listener: () => void): () => void;
    onAiActive?(listener: (active: boolean) => void): () => void;
  };
}

/** The preload's API when present and shaped as expected; null in a plain browser (or on the server). */
export function desktopBridge(win: unknown): DesktopBridge | null {
  const api = (win as { defe2end?: Partial<DesktopBridge> } | undefined)?.defe2end;
  const fns = (o: unknown, names: string[]) => !!o && names.every((n) => typeof (o as Record<string, unknown>)[n] === "function");
  if (!api || !fns(api.sideBrowser, ["open", "close", "setBounds", "navigate", "setDragging", "setDevice", "saveSession"])) return null;
  if (!fns(api.recorder, ["start", "stop", "discard", "onResult", "onCheckRequested"])) return null;
  return api as DesktopBridge;
}

/** Read after mount, so the server render and a plain browser both show nothing. */
export function useDesktopBridge(): DesktopBridge | null {
  const [bridge, setBridge] = useState<DesktopBridge | null>(null);
  useEffect(() => setBridge(desktopBridge(window)), []);
  return bridge;
}

const resultSchema = z.object({
  steps: z.array(stepSchema),
  sourceEventIds: z.array(z.array(z.string())),
  warnings: z.array(z.object({ code: z.string(), eventIds: z.array(z.string()), count: z.number().optional() })),
  eventCount: z.number(),
});
type Result = z.infer<typeof resultSchema>;

const checkRequestSchema = z.object({ eventId: z.string(), check: z.string(), text: z.string().nullable(), selector: z.string().nullable() });
type CheckRequest = z.infer<typeof checkRequestSchema>;

const WARNING_CODES = ["otherTab", "popupNested", "popupNoTrigger", "popupUnsupported", "popupOpenerEvent", "popupNotClosed", "dialogUnmatched", "dialogPrompt", "iframeRootPath", "iframeUnsupported", "noSelector", "invalidStep"] as const;
type WarningCode = (typeof WARNING_CODES)[number];
const isWarningCode = (code: string): code is WarningCode => (WARNING_CODES as readonly string[]).includes(code);

export interface RecorderEnvironment {
  id: string;
  workspaceId: string;
  name: string;
  baseUrl: string;
  useAuthSession: boolean;
}

/** The "Record" entry of the editor; renders nothing outside the desktop app. */
export function RecordButton({ onOpen, disabled }: { onOpen: (bridge: DesktopBridge) => void; disabled?: boolean }) {
  const t = useTranslations("scenarios.recorder");
  const bridge = useDesktopBridge();
  if (!bridge) return null;
  return (
    <Button variant="secondary" disabled={disabled} onClick={() => onOpen(bridge)}>
      <span aria-hidden="true" className="size-2.5 rounded-full bg-fail" />
      {t("open")}
    </Button>
  );
}

const MIN_PANEL = 320;

/** A save failure whose message (from the API) is shown as is. */
class SaveError extends Error {}

export function RecorderPanel({
  bridge,
  environments,
  defaultEnvironmentId,
  onInsert,
  onSaveNew,
  onClose,
}: {
  bridge: DesktopBridge;
  environments: RecorderEnvironment[];
  defaultEnvironmentId?: string;
  onInsert: (steps: Step[]) => void;
  /** Saves the recording as a new scenario of the recorded environment's site; resolves to an error message or nothing. */
  onSaveNew?: (name: string, steps: Step[]) => Promise<string | void>;
  onClose: () => void;
}) {
  const t = useTranslations("scenarios.recorder");
  const [newName, setNewName] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState(defaultEnvironmentId ?? environments[0]?.id);
  const environment = environments.find((e) => e.id === environmentId);
  const [url, setUrl] = useState(environment?.baseUrl ?? "https://");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [checks, setChecks] = useState<CheckRequest[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [panelWidth, setPanelWidth] = useState(400);
  const [aiActive, setAiActive] = useState(false);
  const slot = useRef<HTMLDivElement>(null);

  const bounds = (): Bounds | null => {
    const r = slot.current?.getBoundingClientRect();
    return r ? { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.max(0, r.width), height: Math.max(0, r.height) } : null;
  };

  // Open the side browser over the reserved area, keep its bounds in sync, close it with the panel.
  useEffect(() => {
    // Take the one side browser before opening it, so the workspace column hands it over instead of closing it.
    const release = claimForRecorder();
    const b = bounds();
    if (b) void bridge.sideBrowser.open(environment?.baseUrl, b).catch(() => setError(t("errorBrowser")));
    const sync = () => {
      const next = bounds();
      if (next) void bridge.sideBrowser.setBounds(next);
    };
    const observer = new ResizeObserver(sync);
    if (slot.current) observer.observe(slot.current);
    window.addEventListener("resize", sync);
    const offResult = bridge.recorder.onResult((raw) => {
      const parsed = resultSchema.safeParse(raw);
      if (parsed.success) setResult(parsed.data);
      else setError(t("errorResult"));
    });
    const offCheck = bridge.recorder.onCheckRequested((raw) => {
      const parsed = checkRequestSchema.safeParse(raw);
      if (parsed.success) setChecks((all) => [...all, parsed.data]);
    });
    const offAi = bridge.mcp?.onAiActive?.(setAiActive);
    // An AI browser tool asks for the browser while this panel owns it (its tabs were closed): open it here again.
    const offOpen = bridge.mcp?.onOpenRequested?.(() => {
      const again = bounds();
      if (again) void bridge.sideBrowser.open(undefined, again).catch(() => setError(t("errorBrowser")));
    });
    return () => {
      offOpen?.();
      offAi?.();
      observer.disconnect();
      window.removeEventListener("resize", sync);
      offResult();
      offCheck();
      void bridge.recorder.stop().catch(() => {});
      void bridge.sideBrowser.close().catch(() => {});
      release();
    };
    // Opened once per panel; later environment changes navigate instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof SaveError ? err.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  const start = () =>
    act(async () => {
      setResult(null);
      setChecks([]);
      await bridge.sideBrowser.setDevice(device);
      await bridge.sideBrowser.navigate(url);
      await bridge.recorder.start();
      setRecording(true);
    });
  const stop = () =>
    act(async () => {
      const final = resultSchema.safeParse(await bridge.recorder.stop());
      if (final.success) setResult(final.data);
      setRecording(false);
    });
  const removeStep = (i: number) => act(() => bridge.recorder.discard(result?.sourceEventIds[i] ?? []));
  const skipCheck = (c: CheckRequest) =>
    act(async () => {
      setChecks((all) => all.filter((x) => x.eventId !== c.eventId));
      await bridge.recorder.discard([c.eventId]);
    });
  const keepCheck = (c: CheckRequest) => setChecks((all) => all.filter((x) => x.eventId !== c.eventId));
  const saveLogin = () =>
    act(async () => {
      if (!environment) return;
      const res = (await bridge.sideBrowser.saveSession({ workspaceId: environment.workspaceId, environmentId: environment.id })) as { ok?: boolean; cookieCount?: number; reason?: string } | null;
      if (res?.ok) setNotice(t("loginSaved", { count: res.cookieCount ?? 0 }));
      else setError(res?.reason === "no_cookies" ? t("loginNoCookies") : res?.reason === "not_connected" ? t("loginNotConnected") : t("loginFailed"));
    });

  // Dragging the panel edge: the native view hides meanwhile (it would swallow the pointer).
  function onEdgeDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    void bridge.sideBrowser.setDragging(true);
  }
  function onEdgeMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    setPanelWidth(Math.min(Math.max(MIN_PANEL, e.clientX), window.innerWidth - MIN_PANEL));
  }
  function onEdgeUp(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.releasePointerCapture(e.pointerId);
    void bridge.sideBrowser.setDragging(false);
    const b = bounds();
    if (b) void bridge.sideBrowser.setBounds(b);
  }

  const steps = result?.steps ?? [];
  return (
    <div role="dialog" aria-label={t("title")} className="fixed inset-0 z-40 flex bg-bg">
      <section style={{ width: panelWidth }} className="t-panel-slide flex shrink-0 flex-col border-r border-border bg-bg-surface">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-title-sm">
            {recording && <span aria-hidden="true" className="size-2.5 rounded-full bg-fail motion-safe:animate-pulse" />}
            {recording ? t("recording") : t("title")}
          </h2>
          {aiActive && (
            <span role="status" className="flex items-center gap-1.5 rounded-full bg-bg px-2 py-0.5 text-meta font-semibold">
              <span aria-hidden="true" className="size-2 rounded-full bg-accent motion-safe:animate-pulse" />
              {t("aiActive")}
            </span>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("close")}
          </Button>
        </header>
        <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
          {environments.length > 1 && (
            <label className="flex flex-col gap-1 text-meta font-semibold">
              {t("environment")}
              <select
                value={environmentId}
                disabled={recording}
                onChange={(e) => {
                  setEnvironmentId(e.target.value);
                  const next = environments.find((x) => x.id === e.target.value);
                  if (next) setUrl(next.baseUrl);
                }}
                className={inputClass}
              >
                {environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("startUrl")}
            <input value={url} onChange={(e) => setUrl(e.target.value)} disabled={recording} className={`${inputClass} font-mono`} />
          </label>
          <fieldset className="flex items-center gap-3 text-meta" disabled={recording}>
            <legend className="sr-only">{t("device")}</legend>
            <span className="font-semibold">{t("device")}</span>
            {(["desktop", "mobile"] as const).map((d) => (
              <label key={d} className="flex items-center gap-1.5">
                <input type="radio" name="recorder-device" checked={device === d} onChange={() => setDevice(d)} className="accent-[var(--color-accent)]" />
                {t(`devices.${d}`)}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            {recording ? (
              <Button onClick={() => void stop()} disabled={busy}>
                {t("stop")}
              </Button>
            ) : (
              <Button onClick={() => void start()} disabled={busy || !/^https?:\/\//.test(url)}>
                {t("start")}
              </Button>
            )}
            {environment?.useAuthSession && (
              <Button variant="secondary" onClick={() => void saveLogin()} disabled={busy}>
                {t("saveLogin")}
              </Button>
            )}
          </div>
          {error && <Alert>{error}</Alert>}
          {notice && <Alert tone="info">{notice}</Alert>}
        </div>

        {checks.map((c) => (
          <div key={c.eventId} className="t-stack-in flex flex-col gap-2 border-b border-border bg-accent-soft px-4 py-3 text-meta">
            <p>
              <span className="font-semibold">{t("checkRequested")}</span> {c.check}
              {c.text ? ` "${c.text}"` : ""}
              {c.selector && <span className="block truncate font-mono text-code text-text-muted">{c.selector}</span>}
            </p>
            <span className="flex gap-2">
              <Button onClick={() => keepCheck(c)} disabled={busy}>
                {t("checkAdd")}
              </Button>
              <Button variant="secondary" onClick={() => void skipCheck(c)} disabled={busy}>
                {t("checkSkip")}
              </Button>
            </span>
          </div>
        ))}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {steps.length === 0 ? (
            <p className="px-4 py-8 text-center text-meta text-text-muted">{recording ? t("emptyRecording") : t("empty")}</p>
          ) : (
            <ol className="flex flex-col">
              {steps.map((step, i) => (
                <li key={`${step.id}-${i}`} className="t-stack-in flex items-start gap-2 border-b border-border px-4 py-2">
                  <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-code text-text-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{step.name ?? step.action}</span>
                    <span className="block truncate font-mono text-code text-text-muted">{step.action}</span>
                  </span>
                  <button type="button" onClick={() => void removeStep(i)} disabled={busy} className="text-meta font-semibold text-fail underline-offset-2 hover:underline">
                    {t("removeStep")}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {result && result.warnings.length > 0 && (
            <ul className="flex flex-col gap-1 px-4 py-3 text-meta text-warn">
              {result.warnings.map((w, i) => (
                <li key={`${w.code}-${i}`}>⚠ {isWarningCode(w.code) ? t(`warnings.${w.code}`, { count: w.count ?? 1 }) : w.code}</li>
              ))}
            </ul>
          )}
        </div>
        {newName !== null && onSaveNew && (
          <form
            className="flex flex-col gap-2 border-t border-border px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const failed = await onSaveNew(newName.trim(), steps.map((s) => ({ ...s, id: newStepId() })));
                if (failed) throw new SaveError(failed);
              });
            }}
          >
            <label className="flex flex-col gap-1 text-meta font-semibold">
              {t("newName")}
              <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={200} required autoFocus className={inputClass} />
            </label>
            <span className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setNewName(null)} disabled={busy}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={busy || newName.trim() === ""}>
                {t("saveNewConfirm")}
              </Button>
            </span>
          </form>
        )}
        <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <span className="text-meta text-text-muted">{t("stepCount", { count: steps.length })}</span>
          <span className="flex gap-2">
            {onSaveNew && (
              <Button variant="secondary" disabled={recording || busy || steps.length === 0 || newName !== null} onClick={() => setNewName("")}>
                {t("saveNew")}
              </Button>
            )}
            <Button disabled={recording || busy || steps.length === 0} onClick={() => onInsert(steps.map((s) => ({ ...s, id: newStepId() })))}>
              {t("insert")}
            </Button>
          </span>
        </footer>
      </section>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("resize")}
        onPointerDown={onEdgeDown}
        onPointerMove={onEdgeMove}
        onPointerUp={onEdgeUp}
        className="w-1.5 shrink-0 cursor-col-resize bg-border hover:bg-accent"
      />
      {/* The app draws the side browser over this area. */}
      <div ref={slot} className="flex min-w-0 flex-1 items-center justify-center bg-bg-subtle text-meta text-text-muted">
        {t("browserArea")}
      </div>
    </div>
  );
}
