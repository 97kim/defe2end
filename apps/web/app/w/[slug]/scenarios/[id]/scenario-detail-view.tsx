"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { GuardedLink } from "../../../../../components/navigation-guard";
import { PageHeader, Toasts, useToasts } from "../../../../../components/ui";
import { guardNavigation, registerLeaveGuard } from "../../../../../lib/navigation-guard";
import type { RunSummary } from "../../../../../lib/run-read";
import { browserStore, clearDraft, draftFailureNotice, draftKey } from "../../../../../lib/scenario-draft";
import type { ScenarioDetail } from "../../../../../lib/scenarios";
import { ORDER_KEY, type SiteOption } from "../scenarios-view";
import { StepEditor } from "../step-editor";
import { StartComparison } from "../../comparisons/comparison-ui";
import { ScrollButtons } from "./scroll-buttons";

/** Previous / next in the list's last order (filter and search), when this scenario is in it. */
export function neighbors(order: { id: string; name: string }[], id: string) {
  const i = order.findIndex((o) => o.id === id);
  if (i < 0) return { previous: null, next: null };
  return { previous: order[i - 1] ?? null, next: order[i + 1] ?? null };
}

export function ScenarioDetailView({
  slug,
  userId,
  workspaceName,
  canWrite,
  canRun,
  scenario,
  sites,
  tags,
  history,
  lastTestRunId,
  testRunAvailable,
}: {
  slug: string;
  userId: string;
  workspaceName: string;
  canWrite: boolean;
  canRun: boolean;
  scenario: ScenarioDetail & { editedAgo: string };
  sites: SiteOption[];
  tags: { id: string; name: string }[];
  history: RunSummary[];
  lastTestRunId: string | null;
  testRunAvailable: boolean;
}) {
  const t = useTranslations("scenarios");
  const { toasts, push, dismiss } = useToasts();
  const [reportDraftSave] = useState(() => draftFailureNotice(() => push(t("editor.draftNotKept"), "error")));
  const dirtyRef = useRef(false);
  const scrollArea = useRef<HTMLElement>(null);
  const saveRef = useRef<(() => Promise<boolean>) | null>(null);
  // Bumped on "Discard" so the editor remounts from the saved version.
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [around, setAround] = useState<ReturnType<typeof neighbors>>({ previous: null, next: null });

  // The app-wide guard: shell links, back / previous / next and the workspace switcher ask before leaving.
  useEffect(
    () =>
      registerLeaveGuard({
        isDirty: () => dirtyRef.current,
        save: () => saveRef.current?.() ?? Promise.resolve(false),
        discard: () => {
          clearDraft(browserStore(), draftKey(slug, scenario.id, userId));
          dirtyRef.current = false;
          setEditorEpoch((n) => n + 1);
        },
      }),
    [slug, userId, scenario.id],
  );

  useEffect(() => {
    try {
      const order = JSON.parse(window.sessionStorage.getItem(ORDER_KEY(slug)) ?? "[]") as { id: string; name: string }[];
      setAround(neighbors(order, scenario.id));
    } catch {
      setAround({ previous: null, next: null });
    }
  }, [slug, scenario.id]);

  const guard = useCallback((action: () => void | Promise<void>) => void guardNavigation(action), []);
  const base = `/w/${slug}/scenarios`;

  async function exportOne() {
    const res = await fetch(`/api/w/${slug}/scenarios/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [scenario.id] }) });
    if (!res.ok) return push(t("toast.failed", { message: res.statusText }), "error");
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "defe2end-scenarios.json";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    push(t("toast.exported", { count: 1 }));
  }

  const nav = "inline-flex items-center gap-1 rounded-control px-2 py-1 text-meta font-semibold text-text-secondary hover:bg-accent-soft hover:text-text-primary";
  return (
    <>
      <PageHeader crumbs={[workspaceName, t("title")]} title={scenario.name} />
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-2">
        <GuardedLink href={base} className={nav}>
          ← {t("detail.back")}
        </GuardedLink>
        <span className="flex items-center gap-1">
          {around.previous && (
            <GuardedLink href={`${base}/${around.previous.id}`} className={nav} title={around.previous.name}>
              ‹ {t("detail.previous")}
            </GuardedLink>
          )}
          {around.next && (
            <GuardedLink href={`${base}/${around.next.id}`} className={nav} title={around.next.name}>
              {t("detail.next")} ›
            </GuardedLink>
          )}
        </span>
      </div>
      <section ref={scrollArea} className="min-w-0 flex-1 overflow-y-auto p-6">
        {canRun && (
          <div className="mb-4 flex">
            <StartComparison slug={slug} scenarioId={scenario.id} />
          </div>
        )}
        <StepEditor
          key={`${scenario.id}:${scenario.updatedAt}:${editorEpoch}`}
          slug={slug}
          userId={userId}
          workspaceName={workspaceName}
          scenario={scenario}
          sites={sites}
          allTags={tags}
          canWrite={canWrite}
          onDirtyChange={(dirty) => {
            dirtyRef.current = dirty;
          }}
          guard={guard}
          saveRef={saveRef}
          onToast={push}
          onDraftSaved={reportDraftSave}
          onExport={() => void exportOne()}
          history={history}
          lastTestRunId={lastTestRunId}
          canRun={canRun}
          testRunAvailable={testRunAvailable}
        />
        <ScrollButtons container={scrollArea} raised={toasts.length > 0} />
      </section>
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
