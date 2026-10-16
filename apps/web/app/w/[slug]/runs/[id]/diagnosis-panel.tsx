"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useAiBridge, useProviderStatus, type AiEvent, type Provider } from "../../../../../components/ai/bridge";
import { ProviderNotices, useRefusalText, useTurnErrorText } from "../../../../../components/ai/provider-notice";
import { Alert, Button, Dialog } from "../../../../../components/ui";
import type { DiagnosisView } from "../../../../../lib/diagnoses";
import { hasConsent, recordConsent, sendLock } from "../../../../../lib/diagnosis-consent";
import { buildDiagnosisPrompt, diagnosisLogText, diagnosisThreadId, pickDiagnosisArtifacts } from "../../../../../lib/diagnosis-input";
import type { RunDetail } from "../../../../../lib/run-read";
import { SparklesIcon } from "../run-ui";

// Failure diagnosis (stage 6 contract section 8): only inside the desktop app. Consent once, the exact masked text
// to review each time, one tool-less turn on the user's CLI, then the result is saved apart from the step errors.

async function artifactText(url: string): Promise<string | null> {
  const res = await fetch(url).catch(() => null);
  return res?.ok ? res.text() : null;
}

/** The masked prompt for the shown attempt: its DOM summary of the failed step and its log artifacts around it. */
async function preparePrompt(run: RunDetail, attempt: number): Promise<string | null> {
  const { dom, logs } = pickDiagnosisArtifacts(run.steps, run.artifacts, attempt);
  const [domSummary, ...logTexts] = await Promise.all([dom ? artifactText(dom.url) : Promise.resolve(null), ...logs.map((l) => artifactText(l.url))]);
  const logText = diagnosisLogText(logs.map((l, i) => ({ stepIndex: l.stepIndex, text: logTexts[i] ?? null })));
  return buildDiagnosisPrompt({ scenarioName: run.scenarioName, baseUrl: run.baseUrl, steps: run.steps, runError: run.errorMessage, logText, domSummary });
}

export function DiagnosisPanel({ slug, run, attempt }: { slug: string; run: RunDetail; attempt: number }) {
  const t = useTranslations("ai");
  const format = useFormatter();
  const bridge = useAiBridge();
  const { states, recheck, checking } = useProviderStatus(bridge);
  const errorText = useTurnErrorText();
  const refusalText = useRefusalText();
  const [saved, setSaved] = useState<DiagnosisView[]>([]);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [prompt, setPrompt] = useState<string | null | undefined>(undefined);
  const [preparing, setPreparing] = useState(false);
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const thread = useRef<string | null>(null);
  const lock = useRef(sendLock());
  const [sending, setSending] = useState(false);

  const ready = (states ?? []).filter((s) => s.state === "ready").map((s) => s.provider);
  const chosen = provider && ready.includes(provider) ? provider : (ready[0] ?? null);
  const failedRun = run.status === "failed" || run.status === "error" || run.status === "timed_out";

  useEffect(() => {
    let live = true;
    fetch(`/api/w/${slug}/runs/${run.id}/diagnoses`)
      .then((r) => (r.ok ? r.json() : { diagnoses: [] }))
      .then((body: { diagnoses: DiagnosisView[] }) => live && setSaved(body.diagnoses))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [slug, run.id]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onEvent((event: AiEvent) => {
      if (event.threadId !== thread.current) return;
      if (event.type === "delta") setOutput((o) => o + event.text);
      else if (event.type === "error") {
        setRunning(false);
        thread.current = null;
        setError(errorText(chosen ?? "claude", event));
      } else {
        setRunning(false);
        thread.current = null;
        void save(event.text);
      }
    });
  }); // re-subscribes with the current provider and save()

  async function save(text: string) {
    if (!chosen || !text.trim()) return;
    const res = await fetch(`/api/w/${slug}/runs/${run.id}/diagnoses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: chosen, text }) }).catch(() => null);
    if (!res?.ok) return setError(t("diagnosis.saveFailed"));
    const view = (await res.json()) as DiagnosisView;
    setSaved((list) => [view, ...list]);
    setOutput("");
    setPrompt(undefined);
  }

  async function review() {
    setError(null);
    if (!(await hasConsent())) return setConsentOpen(true);
    setPreparing(true);
    setPrompt(await preparePrompt(run, attempt).catch(() => null));
    setPreparing(false);
  }

  async function send() {
    if (!bridge || !chosen || !prompt || !lock.current.claim()) return;
    setSending(true);
    try {
      setError(null);
      // Withdrawn elsewhere since the preview (or unknown): nothing leaves; ask again.
      if (!(await hasConsent())) {
        setPrompt(undefined);
        return setConsentOpen(true);
      }
      setOutput("");
      const id = diagnosisThreadId();
      thread.current = id;
      setRunning(true);
      const result = await bridge.send({ mode: "diagnosis", threadId: id, provider: chosen, text: prompt });
      if (!result.ok) {
        thread.current = null;
        setRunning(false);
        setError(refusalText(result.reason));
      }
    } finally {
      lock.current.release();
      setSending(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-card border border-border bg-bg-surface p-5 shadow-e1" aria-labelledby="diagnosis-title">
      <h2 id="diagnosis-title" className="flex items-center gap-2 text-title-sm text-text-primary">
        <SparklesIcon />
        {t("diagnosis.title")}
      </h2>
      {!bridge ? (
        <p className="text-meta text-text-muted">{t("diagnosis.appOnly")}</p>
      ) : !failedRun ? (
        <p className="text-meta text-text-muted">{t("diagnosis.nothing")}</p>
      ) : (
        <>
          <p className="text-meta text-text-secondary">{t("diagnosis.intro")}</p>
          <ProviderNotices states={states} checking={checking} onRecheck={recheck} />
          {ready.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {ready.length > 1 && (
                <select aria-label={t("chat.providerLabel")} className="h-9 rounded-control border border-border-strong bg-bg-surface px-2 text-body" value={chosen ?? ""} onChange={(e) => setProvider(e.target.value as Provider)} disabled={running}>
                  {ready.map((p) => (
                    <option key={p} value={p}>
                      {t(`provider.${p}`)}
                    </option>
                  ))}
                </select>
              )}
              {prompt === undefined ? (
                <Button type="button" variant="secondary" onClick={review} disabled={preparing}>
                  {preparing ? t("diagnosis.loading") : t("diagnosis.start")}
                </Button>
              ) : running ? (
                <Button type="button" variant="secondary" onClick={() => thread.current && bridge.stop(thread.current)}>
                  {t("chat.stop")}
                </Button>
              ) : prompt ? (
                <Button type="button" onClick={send} disabled={sending}>
                  {t("chat.send")}
                </Button>
              ) : null}
            </div>
          )}
          {prompt === null && <p className="text-meta text-text-muted">{t("diagnosis.nothing")}</p>}
          {prompt && (
            <details className="rounded-control border border-border bg-bg-subtle">
              <summary className="cursor-pointer px-3 py-2 text-meta font-semibold text-text-secondary">{t("diagnosis.preview")}</summary>
              <pre className="max-h-80 overflow-auto px-3 pb-3 font-mono text-code break-words whitespace-pre-wrap text-text-secondary">{prompt}</pre>
            </details>
          )}
          {(running || output) && (
            <div className="rounded-control border border-border p-3 text-body whitespace-pre-wrap text-text-primary" aria-live="polite">
              {output || <span className="text-text-muted">{t("diagnosis.running")}</span>}
            </div>
          )}
          {error && <Alert>{error}</Alert>}
        </>
      )}
      {saved.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-meta font-semibold text-text-secondary">{t("diagnosis.history")}</h3>
          {saved.map((d) => (
            <article key={d.id} className="rounded-control border border-border bg-bg-subtle p-3">
              <p className="text-meta text-text-muted">
                {t("diagnosis.by", { provider: d.provider === "codex" ? t("provider.codex") : t("provider.claude"), name: d.createdBy?.name ?? "—", time: format.dateTime(new Date(d.createdAt), { dateStyle: "medium", timeStyle: "short" }) })}
              </p>
              <p className="mt-1 text-body whitespace-pre-wrap text-text-primary">{d.text}</p>
            </article>
          ))}
        </div>
      )}
      <Dialog
        open={consentOpen}
        title={t("diagnosis.consent.title")}
        onClose={() => setConsentOpen(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setConsentOpen(false)}>
              {t("diagnosis.consent.cancel")}
            </Button>
            <Button
              type="button"
              onClick={async () => {
                setConsentOpen(false);
                if (await recordConsent()) void review();
                else setError(t("diagnosis.consent.saveFailed"));
              }}
            >
              {t("diagnosis.consent.accept")}
            </Button>
          </>
        }
      >
        <p className="text-body text-text-secondary">{t("diagnosis.consent.body")}</p>
      </Dialog>
    </section>
  );
}
