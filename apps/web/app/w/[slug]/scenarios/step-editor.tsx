"use client";

import { STEP_ACTIONS, stepsSchema, type Step } from "@defe2end/shared";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type DragEvent, type MutableRefObject, type ReactNode } from "react";
import { EyeIcon, LockIcon, MoreIcon } from "../../../../components/icons";
import { Button, buttonClass, inputClass, Menu, Tag, Toggle } from "../../../../components/ui";
import { api } from "../../../../lib/api-client";
import { browserStore, clearDraft, draftKey, isStaleDraft, loadDraft, saveDraft } from "../../../../lib/scenario-draft";
import { cleanStep, moveItem, newStepId } from "../../../../lib/scenario-helpers";
import { DEFAULT_ACTION, issuesByField } from "../../../../lib/step-fields";
import type { RunSummary } from "../../../../lib/run-read";
import type { ScenarioDetail } from "../../../../lib/scenarios";
import { ActionIcon, ArchiveIcon, CheckIcon, GripIcon, PlayIcon, PlusIcon, ServerIcon } from "./icons";
import { LastTestRun } from "./last-test-run";
import { RecordButton, RecorderPanel, type DesktopBridge } from "./recorder-panel";
import { RunHistory, StartRunDialog } from "./run-controls";
import { ActionPicker, StepFields } from "./step-fields";
import type { SiteOption } from "./scenarios-view";

type Props = {
  slug: string;
  userId: string;
  workspaceName: string;
  scenario: ScenarioDetail & { editedAgo: string };
  sites: SiteOption[];
  allTags: { id: string; name: string }[];
  canWrite: boolean;
  onDirtyChange: (dirty: boolean) => void;
  /** Runs `action` through the page's unsaved-changes guard. */
  guard: (action: () => void | Promise<void>) => void;
  /** The guard's "Save and continue" calls this. */
  saveRef: MutableRefObject<(() => Promise<boolean>) | null>;
  onToast: (text: string, tone?: "ok" | "error") => void;
  /** Told whether each draft write was kept. */
  onDraftSaved: (saved: boolean) => void;
  onExport: () => void;
  /** The scenario's latest runs, oldest first (history strip). */
  history: RunSummary[];
  /** This scenario's latest test run (server side: Run.testOfScenarioId), if still kept. */
  lastTestRunId?: string | null;
  /** `run.create`: test runs and runs of the saved version. */
  canRun: boolean;
  /** The worker team's test-run endpoint is on this server (lib/run-endpoints.ts). */
  testRunAvailable: boolean;
};

const snapshot = (name: string, description: string, siteId: string, steps: Step[], retryOnFailure: boolean | null, maskingEnabled = true) =>
  JSON.stringify({ name: name.trim(), description, siteId, steps: steps.map(cleanStep), retryOnFailure, maskingEnabled });

/** Schema messages per step index and field (`_step` for the step as a whole). */
function stepErrors(steps: Step[]): Map<number, Record<string, string>> {
  const parsed = stepsSchema.safeParse(steps.map(cleanStep));
  return parsed.success ? new Map() : issuesByField(parsed.error.issues);
}

/** Saved before the step format changed (unknown action or old keys); the editor can't show its fields. */
const isLegacyStep = (step: Step) =>
  !(STEP_ACTIONS as readonly string[]).includes(step.action) || "target" in step || "options" in step;

export function StepEditor({ slug, userId, workspaceName, scenario, sites, allTags, canWrite, onDirtyChange, guard, saveRef, onToast, onDraftSaved, onExport, history, lastTestRunId: serverLastTestRunId = null, canRun, testRunAvailable }: Props) {
  const t = useTranslations("scenarios");
  const router = useRouter();
  const archived = scenario.archivedAt !== null;
  const readOnly = !canWrite || archived;

  const [name, setName] = useState(scenario.name);
  const [description, setDescription] = useState(scenario.description);
  const [siteId, setSiteId] = useState(scenario.site.id);
  const [steps, setSteps] = useState<Step[]>(scenario.steps);
  const [recorder, setRecorder] = useState<DesktopBridge | null>(null);
  // success-check: the Save button's check draws in after each successful save (bumped to re-run it).
  const [savedTick, setSavedTick] = useState(0);
  // Last test run of this scenario's editor, read on the server; a new one replaces it right away.
  const [lastTestRunId, setLastTestRunId] = useState<string | null>(serverLastTestRunId);
  useEffect(() => setLastTestRunId(serverLastTestRunId), [serverLastTestRunId]);
  const [retryOnFailure, setRetryOnFailure] = useState(scenario.retryOnFailure);
  const [maskingEnabled, setMaskingEnabled] = useState(scenario.maskingEnabled);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Field errors show after the first save attempt and then follow edits.
  const [checked, setChecked] = useState(false);
  const errors = useMemo(() => (checked ? stepErrors(steps) : new Map<number, Record<string, string>>()), [checked, steps]);
  const legacyCount = steps.filter(isLegacyStep).length;
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  // Saves send the version the edits were based on; a restored draft keeps its own base.
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(scenario.updatedAt);
  const [restored, setRestored] = useState<null | { stale: boolean }>(null);
  const draftId = draftKey(slug, scenario.id, userId);
  const [starting, setStarting] = useState<null | "test" | "saved">(null);

  const site = sites.find((s) => s.id === siteId);
  const [envId, setEnvId] = useState(site?.environments[0]?.id);
  const env = site?.environments.find((e) => e.id === envId) ?? site?.environments[0];

  const original = useMemo(() => snapshot(scenario.name, scenario.description, scenario.site.id, scenario.steps, scenario.retryOnFailure, scenario.maskingEnabled), [scenario]);
  const dirty = !readOnly && snapshot(name, description, siteId, steps, retryOnFailure, maskingEnabled) !== original;
  const api_ = `/api/w/${slug}/scenarios/${scenario.id}`;

  // Restore a draft kept from an earlier visit (browser Back/Forward can't be blocked, so edits are kept instead).
  // Declared before the persist effect so it reads the draft before that effect can clear it.
  useEffect(() => {
    if (readOnly) return;
    const draft = loadDraft(browserStore(), draftId);
    if (!draft) return;
    setName(draft.name);
    setDescription(draft.description);
    setSiteId(sites.some((s) => s.id === draft.siteId) ? draft.siteId : scenario.site.id);
    setSteps(draft.steps);
    if (scenario.retryOnFailure !== null && typeof draft.retryOnFailure === "boolean") setRetryOnFailure(draft.retryOnFailure);
    setBaseUpdatedAt(draft.baseUpdatedAt);
    setRestored({ stale: isStaleDraft(draft, scenario.updatedAt) });
    // Mount only: this editor instance is keyed by scenario id + version.
  }, []);
  // Keep the draft while dirty; drop it once the editor matches the saved version again.
  useEffect(() => {
    if (readOnly) return;
    if (dirty) onDraftSaved(saveDraft(browserStore(), draftId, { baseUpdatedAt, name, description, siteId, steps, retryOnFailure: retryOnFailure ?? undefined }));
    else clearDraft(browserStore(), draftId);
  }, [readOnly, dirty, draftId, baseUpdatedAt, name, description, siteId, steps, retryOnFailure, onDraftSaved]);

  function discardDraft() {
    clearDraft(browserStore(), draftId);
    setName(scenario.name);
    setDescription(scenario.description);
    setSiteId(scenario.site.id);
    setSteps(scenario.steps);
    setRetryOnFailure(scenario.retryOnFailure);
    setMaskingEnabled(scenario.maskingEnabled);
    setBaseUpdatedAt(scenario.updatedAt);
    setRestored(null);
    setConflict(false);
    setChecked(false);
    setError(undefined);
  }

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const updateStep = (index: number, patch: Partial<Step>) => setSteps((all) => all.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  function addStep() {
    const step: Step = { id: newStepId(), action: DEFAULT_ACTION };
    setSteps((all) => [...all, step]);
    setSelectedId(step.id);
    requestAnimationFrame(() => document.getElementById(`step-action-${step.id}`)?.focus());
  }

  // "/" adds a step and focuses its action picker (ap-1: "or press / to pick an action").
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || el.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      addStep();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** True when saved; false when validation, a conflict or the server refused it. */
  async function save(): Promise<boolean> {
    setError(undefined);
    const cleaned = steps.map(cleanStep);
    const parsed = stepsSchema.safeParse(cleaned);
    if (!parsed.success) {
      setChecked(true);
      // Open the first broken step so its field messages are visible.
      const first = issuesByField(parsed.error.issues).keys().next().value;
      if (first !== undefined && steps[first]) setSelectedId(steps[first].id);
      setError(t("editor.invalidSteps"));
      return false;
    }
    setChecked(false);
    setSaving(true);
    const res = await api(api_, "PATCH", {
      updatedAt: baseUpdatedAt,
      name: name.trim(),
      description,
      siteId,
      steps: cleaned,
      // Sent only when changed, so a server without the setting still saves everything else.
      ...(retryOnFailure !== null && retryOnFailure !== scenario.retryOnFailure ? { retryOnFailure } : {}),
      ...(maskingEnabled !== scenario.maskingEnabled ? { maskingEnabled } : {}),
    });
    setSaving(false);
    if (res.status === 409) {
      setConflict(true);
      return false;
    }
    if (!res.ok) {
      setError(res.error?.message);
      return false;
    }
    clearDraft(browserStore(), draftId);
    setSavedTick((n) => n + 1);
    onToast(t("toast.saved", { count: cleaned.length }));
    onDirtyChange(false);
    router.refresh();
    return true;
  }
  saveRef.current = save;

  // Duplicate, archive and unarchive replace the editor, so they pass the unsaved-changes guard first.
  const run = (path: string, toast: string, after?: (data: ScenarioDetail) => void) =>
    guard(async () => {
      const res = await api<ScenarioDetail>(path, "POST");
      if (!res.ok) return onToast(t("toast.failed", { message: res.error?.message ?? "" }), "error");
      if (path.endsWith("/archive")) clearDraft(browserStore(), draftId);
      if (toast) onToast(toast);
      if (after) after(res.data!);
      else router.push(`/w/${slug}/scenarios/${scenario.id}`, { scroll: false });
      router.refresh();
    });

  async function changeTags(method: "POST" | "DELETE", value: string) {
    const res = method === "POST" ? await api(`${api_}/tags`, "POST", { name: value }) : await api(`${api_}/tags/${value}`, "DELETE");
    if (!res.ok) return onToast(t("toast.failed", { message: res.error?.message ?? "" }), "error");
    router.refresh();
  }

  // Native drag and drop from the grip handle; up/down in the step menu does the same by keyboard.
  const onDrop = (e: DragEvent, to: number) => {
    e.preventDefault();
    if (dragFrom !== null) setSteps((all) => moveItem(all, dragFrom, to));
    setDragFrom(null);
    setDragOver(null);
  };

  const optionSummary = (step: Step) => {
    const parts: string[] = [];
    if (step.name) parts.push(step.name);
    if (step.timeout !== undefined) parts.push(`${t("editor.optionTimeout")} ${step.timeout / 1000}s`);
    if (step.optional) parts.push(t("editor.optionOptional"));
    return parts.join(" · ");
  };

  const environments = site?.environments ?? [];
  const testRunBlocked: ReactNode | null = !canRun ? (
    <>
      <span className="block font-semibold">{t("viewer.testRunTitle")}</span>
      {t("viewer.testRunBody")}
    </>
  ) : !testRunAvailable ? (
    t("editor.testRunLater")
  ) : environments.length === 0 ? (
    t("editor.noEnvironments")
  ) : steps.length === 0 ? (
    t("editor.noSteps")
  ) : null;
  // Sticky header: once the editor's top scrolls out, only "title + buttons" stay (compact, ~56px).
  const sentinel = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setCompact(!entry!.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const runBlocked = !canRun ? t("run.viewerHint") : archived ? t("run.archivedHint") : dirty ? t("run.saveFirst") : environments.length === 0 ? t("editor.noEnvironments") : null;

  return (
    // The header sticks at -top-6 to cancel the scroll area's p-6, so it sits flush with the top and nothing shows above it.
    // overflow-clip (not hidden) keeps the rounded corners without becoming a scroll container, so the
    // header can stick to the page's scroll area.
    <article className="flex flex-col overflow-clip rounded-card border border-border bg-bg-surface shadow-e2">
      <div ref={sentinel} aria-hidden="true" className="h-px" />
      {/* Title, meta, tags and actions — sticky; meta and tags fold away when compact */}
      <header
        data-compact={compact || undefined}
        className={`sticky -top-6 z-20 flex items-center justify-between gap-4 bg-bg-surface px-6 transition-[padding,box-shadow] duration-[var(--motion-base)] ease-[var(--motion-ease)] motion-reduce:transition-none ${
          compact ? "border-b border-border py-2.5 shadow-e1" : "pt-5 pb-4"
        }`}
      >
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            readOnly={readOnly}
            maxLength={200}
            aria-label={t("editor.name")}
            aria-invalid={name.trim() === "" || undefined}
            className="-ml-1.5 w-full truncate rounded-control border border-transparent px-1.5 py-0.5 text-title-lg read-only:cursor-default hover:border-border focus:border-accent focus:outline-none read-only:hover:border-transparent aria-invalid:border-fail"
          />
          <div
            aria-hidden={compact || undefined}
            className={`grid transition-[grid-template-rows,opacity] duration-[var(--motion-base)] ease-[var(--motion-ease)] motion-reduce:transition-none ${compact ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"}`}
          >
          <div className="min-h-0 overflow-hidden" inert={compact || undefined}>
          <p className="mt-0.5 text-body text-text-muted">
            {scenario.updatedByName
              ? t("editor.meta", { count: steps.length, name: scenario.updatedByName, when: scenario.editedAgo })
              : t("editor.metaNoName", { count: steps.length, when: scenario.editedAgo })}
            {dirty && <span className="ml-2 font-semibold text-warn">· {t("editor.unsaved")}</span>}
          </p>
          <TagRow
            tags={scenario.tags}
            allTags={allTags}
            editable={canWrite && !archived}
            onAdd={(n) => changeTags("POST", n)}
            onRemove={(id) => changeTags("DELETE", id)}
          />
          </div>
          </div>
          {/* Compact: the unsaved mark stays visible next to the title row. */}
          {compact && dirty && <span className="text-meta font-semibold text-warn">{t("editor.unsaved")}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="group relative">
            <Button
              variant="secondary"
              disabled={testRunBlocked !== null}
              aria-describedby={testRunBlocked ? `testrun-${scenario.id}` : undefined}
              onClick={() => setStarting("test")}
            >
              <PlayIcon />
              {t("editor.testRun")}
            </Button>
            {testRunBlocked && (
              <span id={`testrun-${scenario.id}`} role="tooltip" className="pointer-events-none absolute top-full right-0 z-20 mt-2 hidden w-64 rounded-control bg-accent px-3 py-2 text-meta text-white shadow-e3 group-focus-within:block group-hover:block">
                {testRunBlocked}
              </span>
            )}
          </span>
          {canWrite ? (
            <>
              {!archived && <RecordButton onOpen={setRecorder} disabled={environments.length === 0} />}
              {!archived && (
                <Button onClick={() => void save()} disabled={!dirty || saving || name.trim() === ""}>
                  <span key={savedTick} className="t-success-check" data-state={savedTick > 0 ? "in" : "out"}>
                    <CheckIcon />
                  </span>
                  {saving ? t("editor.saving") : t("editor.save")}
                </Button>
              )}
              <Menu
                label={t("editor.more")}
                trigger={<MoreIcon />}
                items={[
                  {
                    label: t("editor.duplicate"),
                    onSelect: () =>
                      run(`${api_}/duplicate`, "", (copy) => {
                        onToast(t("toast.duplicated", { name: copy.name }));
                        router.push(`/w/${slug}/scenarios/${copy.id}`, { scroll: false });
                      }),
                  },
                  { label: t("editor.exportOne"), onSelect: onExport },
                  archived
                    ? { label: t("editor.unarchive"), onSelect: () => run(`${api_}/unarchive`, t("toast.unarchived")) }
                    : { label: t("editor.archive"), onSelect: () => run(`${api_}/archive`, t("toast.archived")), danger: true },
                ]}
              />
            </>
          ) : (
            <span className="inline-flex h-9 items-center gap-2 rounded-control border border-border-strong bg-bg-surface px-3.5 font-semibold text-text-secondary">
              <LockIcon width={16} height={16} />
              {t("viewer.badge")}
            </span>
          )}
        </div>
      </header>

      {/* Site, environment and runner */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 pb-4">
        {sites.length > 1 && !readOnly ? (
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label={t("editor.site")} className={inputClass.replace("w-full", "w-auto")}>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-body font-semibold">{site?.name ?? scenario.site.name}</span>
        )}
        {site && site.environments.length > 0 ? (
          <>
            <div role="radiogroup" aria-label={t("editor.environment")} className="inline-flex rounded-control border border-border bg-bg-subtle p-0.5">
              {site.environments.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="radio"
                  aria-checked={e.id === env?.id}
                  onClick={() => setEnvId(e.id)}
                  className={`flex h-7 items-center gap-1.5 rounded-[6px] px-3 text-body ${e.id === env?.id ? "bg-bg-surface font-semibold shadow-e1" : "text-text-secondary"}`}
                >
                  <span className={`size-1.5 rounded-full ${e.id === env?.id ? "bg-accent" : "bg-border-strong"}`} aria-hidden="true" />
                  {e.name}
                </button>
              ))}
            </div>
            <span className="truncate font-mono text-code text-text-muted">{env ? hostOf(env.baseUrl) : ""}</span>
          </>
        ) : (
          <span className="text-meta text-text-muted">{t("editor.noEnvironments")}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-body text-text-secondary">
          <ServerIcon />
          {t("editor.server")}
        </span>
      </div>

      {!canWrite && (
        <div className="flex items-start gap-3 border-y border-border bg-bg-subtle px-6 py-3">
          <EyeIcon width={18} height={18} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">{t("viewer.title", { workspace: workspaceName })}</p>
            <p className="text-text-secondary">{t("viewer.body")}</p>
          </div>
        </div>
      )}
      {canWrite && archived && (
        <div className="flex items-center gap-3 border-y border-border bg-bg-subtle px-6 py-3">
          <ArchiveIcon width={18} height={18} />
          <p className="flex-1">{t("editor.archivedNotice")}</p>
          <Button variant="secondary" onClick={() => run(`${api_}/unarchive`, t("toast.unarchived"))}>
            {t("editor.unarchive")}
          </Button>
        </div>
      )}
      {restored && !conflict && (
        <div role="status" className={`flex items-center gap-3 border-y px-6 py-3 ${restored.stale ? "border-warn/30 bg-timed-out-soft" : "border-border bg-accent-soft"}`}>
          <p className="flex-1">
            <span className="font-semibold">{t("editor.draftRestored")}</span>{" "}
            <span className="text-text-secondary">{restored.stale ? t("editor.draftStale") : t("editor.draftRestoredBody")}</span>
          </p>
          <Button variant="secondary" onClick={discardDraft}>
            {t("editor.discardDraft")}
          </Button>
          <Button onClick={() => void save()} disabled={saving || name.trim() === ""}>
            {t("editor.save")}
          </Button>
        </div>
      )}
      {conflict && (
        <div role="alert" className="flex items-center gap-3 border-y border-warn/30 bg-timed-out-soft px-6 py-3">
          <p className="flex-1 text-text-primary">{t("editor.conflict")}</p>
          <Button variant="secondary" onClick={() => {
              discardDraft();
              router.refresh();
            }}>
            {t("editor.reload")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="border-y border-fail/30 bg-fail-soft px-6 py-2.5 text-fail">
          {error}
        </p>
      )}

      {legacyCount > 0 && (
        <p role="alert" className="border-y border-warn/30 bg-timed-out-soft px-6 py-2.5">
          {t("editor.legacySteps", { count: legacyCount })}
        </p>
      )}

      {/* Description */}
      {(!readOnly || description) && (
        <div className="border-t border-border px-6 py-3">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            readOnly={readOnly}
            rows={description.includes("\n") ? 3 : 1}
            maxLength={5000}
            aria-label={t("editor.description")}
            placeholder={t("editor.descriptionPlaceholder")}
            className="w-full resize-y rounded-control border border-transparent bg-transparent px-1.5 py-1 text-body text-text-secondary placeholder:text-text-muted hover:border-border focus:border-accent focus:outline-none read-only:hover:border-transparent"
          />
        </div>
      )}

      {/* Whole-run retry (spec 4.3) */}
      {retryOnFailure !== null && (
        <div className="flex flex-col gap-1 border-t border-border px-6 py-3">
          <Toggle checked={retryOnFailure} onChange={setRetryOnFailure} label={t("retry.label")} disabled={readOnly} />
          <p className="flex items-start gap-1.5 text-meta text-text-muted">{t("retry.warning")}</p>
        </div>
      )}

      {/* Screen masking (stage 7 section 5) */}
      <div className="flex flex-col gap-1 border-t border-border px-6 py-3">
        <Toggle checked={maskingEnabled} onChange={setMaskingEnabled} label={t("masking.label")} disabled={readOnly} />
        <p className={`flex items-start gap-1.5 text-meta ${maskingEnabled ? "text-text-muted" : "text-warn"}`}>{maskingEnabled ? t("masking.help") : t("masking.off")}</p>
      </div>

      {/* Steps */}
      <div role="table" aria-label={t("title")} className="border-t border-border">
        <div role="row" className={`grid ${GRID} border-b border-border bg-bg-subtle px-4 py-2.5 text-label uppercase tracking-wider text-text-muted`}>
          <span role="columnheader" className="col-span-2" />
          <span role="columnheader">{t("editor.colAction")}</span>
          <span role="columnheader">{t("editor.colTarget")}</span>
          <span role="columnheader">{t("editor.colValue")}</span>
          <span role="columnheader" />
        </div>
        {steps.length === 0 && <p className="px-6 py-8 text-center text-text-muted">{t("editor.noSteps")}</p>}
        {steps.map((step, index) => {
          const selected = step.id === selectedId;
          const stepIssues = errors.get(index);
          const legacy = isLegacyStep(step);
          const bad = stepIssues !== undefined || legacy;
          const summary = optionSummary(step);
          return (
            <div
              key={step.id}
              role="row"
              aria-invalid={bad || undefined}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                setDragOver(index);
              }}
              onDrop={(e) => onDrop(e, index)}
              className={`relative border-b border-border ${selected ? "bg-bg-surface before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-accent" : ""} ${bad ? "bg-fail-soft" : ""} ${
                dragOver === index && dragFrom !== null && dragFrom !== index ? "shadow-[inset_0_2px_0_var(--color-accent)]" : ""
              } ${dragFrom === index ? "opacity-50" : ""}`}
            >
              <div className={`grid ${GRID} cursor-pointer items-center px-4 py-3 hover:bg-bg-subtle/60`} onClick={() => setSelectedId(selected ? null : step.id)}>
                <span role="cell" className="flex justify-center">
                  {!readOnly && (
                    <span
                      draggable
                      onDragStart={(e) => {
                        setDragFrom(index);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDragFrom(null);
                        setDragOver(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={t("editor.dragHandle", { index: index + 1 })}
                      className="cursor-grab text-text-muted active:cursor-grabbing"
                    >
                      <GripIcon />
                    </span>
                  )}
                </span>
                <span role="cell">
                  <span
                    className={`flex size-6 items-center justify-center rounded-full font-mono text-code-sm ${selected ? "bg-accent text-white" : bad ? "bg-fail text-white" : "border border-border bg-bg-subtle text-text-secondary"}`}
                  >
                    {index + 1}
                  </span>
                </span>
                <span role="cell" className="flex items-center gap-2 font-semibold">
                  <ActionIcon action={step.action} />
                  {legacy ? t("editor.legacyStep") : t(`actions.${step.action}`)}
                </span>
                <span role="cell" className="min-w-0 pr-4">
                  <span className="block truncate font-mono text-code">{step.selector || step.url || (step.position ? `${step.position.x}, ${step.position.y}` : "") || "—"}</span>
                  {summary && <span className="block truncate text-meta text-text-muted">{summary}</span>}
                </span>
                <span role="cell" className="truncate pr-2 font-mono text-code">
                  {step.value || step.expected || "—"}
                </span>
                <span role="cell" className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                  {!readOnly && (
                    <Menu
                      label={t("editor.stepMenu", { index: index + 1 })}
                      trigger={<MoreIcon />}
                      items={[
                        { label: t("editor.moveUp"), disabled: index === 0, onSelect: () => setSteps((all) => moveItem(all, index, index - 1)) },
                        { label: t("editor.moveDown"), disabled: index === steps.length - 1, onSelect: () => setSteps((all) => moveItem(all, index, index + 1)) },
                        {
                          label: t("editor.duplicateStep"),
                          onSelect: () => setSteps((all) => [...all.slice(0, index + 1), { ...structuredClone(step), id: newStepId() }, ...all.slice(index + 1)]),
                        },
                        { label: t("editor.deleteStep"), danger: true, onSelect: () => setSteps((all) => all.filter((_, i) => i !== index)) },
                      ]}
                    />
                  )}
                </span>
              </div>

              {selected && !readOnly && (
                <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 px-4 pb-4 pl-[72px]">
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`step-action-${step.id}`} className="text-meta font-semibold">
                      {t("editor.action")}
                    </label>
                    <ActionPicker id={`step-action-${step.id}`} value={step.action} onChange={(action) => updateStep(index, { action })} />
                    {legacy && <span className="text-meta text-fail">{t("editor.legacyStepHint")}</span>}
                    {stepIssues?._step && <span role="alert" className="text-meta text-fail">{stepIssues._step}</span>}
                  </div>
                  <StepFields slug={slug} step={step} errors={stepIssues} onChange={(patch) => updateStep(index, patch)} />
                </div>
              )}
            </div>
          );
        })}
        {!readOnly && (
          <div className="px-6 py-3">
            {/* A secondary button, not a table row: the editor's one primary button is Save. */}
            <button type="button" onClick={addStep} className={buttonClass("secondary")}>
              <PlusIcon />
              <span>{t("editor.addStep")}</span>
              <kbd className="ml-1 rounded-[4px] border border-border bg-bg-subtle px-1.5 font-mono text-code-sm font-normal text-text-muted">/</kbd>
            </button>
          </div>
        )}
      </div>

      <RunHistory
        slug={slug}
        scenarioId={scenario.id}
        runs={history}
        lastTestRun={
          lastTestRunId && (
            <LastTestRun
              slug={slug}
              runId={lastTestRunId}
              onGone={() => setLastTestRunId(null)}
            />
          )
        }
        action={
          canRun && (
            <Button variant="secondary" className="h-7 px-2.5" disabled={runBlocked !== null} title={runBlocked ?? undefined} onClick={() => setStarting("saved")}>
              <PlayIcon />
              {t("run.runSaved")}
            </Button>
          )
        }
      />
      {recorder && (
        <RecorderPanel
          bridge={recorder}
          environments={environments}
          defaultEnvironmentId={env?.id}
          onInsert={(recorded) => {
            // Appended after the editor's steps; the scenario is saved with Save as usual.
            setSteps((all) => [...all, ...recorded]);
            setRecorder(null);
          }}
          onSaveNew={async (newName, recorded) => {
            // The recorded environment belongs to this editor's site, so the new scenario goes there too.
            const res = await api<{ id: string }>(`/api/w/${slug}/scenarios`, "POST", { name: newName, siteId, steps: recorded.map(cleanStep) });
            if (!res.ok) return res.error?.message ?? t("toast.failed", { message: "" });
            setRecorder(null);
            onToast(t("toast.created"));
            guard(() => router.push(`/w/${slug}/scenarios/${res.data!.id}`));
          }}
          onClose={() => setRecorder(null)}
        />
      )}
      {starting && (
        <StartRunDialog
          slug={slug}
          mode={starting}
          scenarioId={scenario.id}
          steps={steps.map(cleanStep)}
          environments={environments}
          defaultEnvironmentId={env?.id}
          onStarted={(runId) => {
            if (starting === "test") setLastTestRunId(runId);
          }}
          onClose={() => setStarting(null)}
        />
      )}
    </article>
  );
}

const GRID = "grid-cols-[24px_36px_150px_minmax(0,1fr)_minmax(0,200px)_40px]";

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function TagRow({
  tags,
  allTags,
  editable,
  onAdd,
  onRemove,
}: {
  tags: { id: string; name: string }[];
  allTags: { id: string; name: string }[];
  editable: boolean;
  onAdd: (name: string) => void;
  onRemove: (id: string) => void;
}) {
  const t = useTranslations("scenarios.editor");
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  if (!editable && tags.length === 0) return null;
  const submit = () => {
    const name = value.trim();
    if (name) onAdd(name);
    setValue("");
    setAdding(false);
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label={t("tags")}>
      {tags.map((tag) => (
        <Tag key={tag.id} onRemove={editable ? () => onRemove(tag.id) : undefined} removeLabel={t("removeTag", { name: tag.name })}>
          {tag.name}
        </Tag>
      ))}
      {editable &&
        (adding ? (
          <>
            <input
              autoFocus
              list="scenario-tag-options"
              value={value}
              maxLength={100}
              placeholder={t("tagPlaceholder")}
              aria-label={t("addTag")}
              onChange={(e) => setValue(e.target.value)}
              onBlur={submit}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") {
                  setValue("");
                  setAdding(false);
                }
              }}
              className="h-6 w-32 rounded-tag border border-border-strong px-1.5 font-mono text-code-sm focus:border-accent focus:outline-none"
            />
            <datalist id="scenario-tag-options">
              {allTags.filter((a) => !tags.some((tag) => tag.id === a.id)).map((a) => (
                <option key={a.id} value={a.name} />
              ))}
            </datalist>
          </>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="inline-flex h-5 items-center gap-1 rounded-tag border border-dashed border-border-strong px-1.5 text-meta text-text-muted hover:text-text-primary">
            <PlusIcon width={11} height={11} />
            {t("addTag")}
          </button>
        ))}
    </div>
  );
}
