"use client";
// Environment comparison widgets: verdict badge, compare again / cancel, the folded structure diff and the
// start dialog on a scenario page.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, buttonClass, inputClass } from "../../../../components/ui";

const VERDICT_CLASS: Record<string, string> = {
  same: "bg-pass-soft text-pass",
  different: "bg-timed-out-soft text-warn",
  incomparable: "bg-cancelled-soft text-cancelled",
};

export function VerdictBadge({ verdict, label }: { verdict: string | null; label: string }) {
  return <span className={`inline-flex h-6 items-center rounded-full px-2 text-meta font-semibold ${verdict ? VERDICT_CLASS[verdict] : "text-text-muted"}`}>{label}</span>;
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; message?: string; reasons?: string[] }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return { ok: true };
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; reasons?: string[] } };
  return { ok: false, message: json.error?.message, reasons: json.error?.reasons };
}

export function ComparisonActions({ slug, id, status, tolerance, canRecompare, canCancel }: { slug: string; id: string; status: string; tolerance: number; canRecompare: boolean; canCancel: boolean }) {
  const t = useTranslations("comparisons.detail");
  const router = useRouter();
  const [busy, setBusy] = useState<"recompare" | "cancel" | null>(null);
  const [value, setValue] = useState(String(tolerance));
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: "recompare" | "cancel") => {
    setBusy(kind);
    setError(null);
    const result = kind === "recompare" ? await post(`/api/w/${slug}/comparisons/${id}/recompare`, { tolerance: Number(value) }) : await post(`/api/w/${slug}/comparisons/${id}/cancel`, {});
    if (!result.ok) setError(result.message ?? "");
    setBusy(null);
    router.refresh();
  };
  const finished = status === "done" || status === "error";
  return (
    <div className="flex flex-wrap items-end gap-2">
      {canRecompare && finished && (
        <>
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("tolerance")}
            <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className={`${inputClass} w-24`} />
          </label>
          <button type="button" className={buttonClass("secondary")} disabled={busy !== null || !(Number(value) >= 0 && Number(value) <= 100)} onClick={() => void run("recompare")}>
            {busy === "recompare" ? t("recomparing") : t("recompare")}
          </button>
        </>
      )}
      {canCancel && status === "running" && (
        <button type="button" className={buttonClass("ghost")} disabled={busy !== null} onClick={() => void run("cancel")}>
          {busy === "cancel" ? t("cancelling") : t("cancel")}
        </button>
      )}
      {error !== null && <Alert>{t("error", { message: error })}</Alert>}
    </div>
  );
}

type Entry = { kind: "same" | "moved" | "left_only" | "right_only" | "changed"; text?: string; leftText?: string; rightText?: string; at?: "left" | "right" };
const FOLD_LINES = 400;
const ENTRY_CLASS: Record<Entry["kind"], string> = {
  same: "text-text-muted",
  moved: "bg-running-soft",
  left_only: "bg-fail-soft",
  right_only: "bg-pass-soft",
  changed: "bg-timed-out-soft",
};

/** Loads the structure diff file and shows the first 400 rows, the rest behind "show all". */
export function StructureDiff({ url }: { url: string }) {
  const t = useTranslations("comparisons.detail");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    void fetch(url)
      .then((r) => r.json() as Promise<{ entries: Entry[] }>)
      .then((d) => live && setEntries(d.entries))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [url]);
  if (!entries) return <p className="text-meta text-text-muted">{t("loading")}</p>;
  const shown = all ? entries : entries.slice(0, FOLD_LINES);
  return (
    <div className="flex flex-col gap-2">
      <pre className="max-h-[32rem] overflow-auto rounded-card border border-border bg-bg-subtle p-3 font-mono text-meta">
        {shown.map((e, i) => (
          <div key={i} className={ENTRY_CLASS[e.kind]}>
            <span className="inline-block w-24 select-none text-text-muted">{e.kind === "moved" ? `${t("kind.moved")} (${e.at === "left" ? t("left") : t("right")})` : t(`kind.${e.kind}`)}</span>
            {e.kind === "changed" ? `${e.leftText} → ${e.rightText}` : e.text}
          </div>
        ))}
      </pre>
      {!all && entries.length > FOLD_LINES && (
        <button type="button" className={buttonClass("ghost")} onClick={() => setAll(true)}>
          {t("showAll", { count: entries.length })}
        </button>
      )}
    </div>
  );
}

type Choices = {
  environments: { id: string; name: string; baseUrl: string }[];
  defaultLeftId: string | null;
  defaultRightId: string | null;
  hasScreenshotStep: boolean;
  desktop: { id: string; label: string; missing: string[] } | null;
};

/** "Compare environments" on a scenario page: two environments, where to run, tolerance. */
export function StartComparison({ slug, scenarioId }: { slug: string; scenarioId: string }) {
  const t = useTranslations("comparisons.start");
  const tLocation = useTranslations("comparisons.location");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [location, setLocation] = useState<"server" | "desktop">("server");
  const [tolerance, setTolerance] = useState("5");
  const [errors, setErrors] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || choices) return;
    void fetch(`/api/w/${slug}/comparisons/choices?scenarioId=${encodeURIComponent(scenarioId)}`)
      .then((r) => r.json() as Promise<Choices>)
      .then((c) => {
        setChoices(c);
        setLeft(c.defaultLeftId ?? "");
        setRight(c.defaultRightId ?? "");
      });
  }, [open, choices, slug, scenarioId]);
  const submit = async () => {
    setBusy(true);
    setErrors(null);
    const res = await fetch(`/api/w/${slug}/comparisons`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId, leftEnvironmentId: left, rightEnvironmentId: right, location, tolerance: Number(tolerance) }),
    });
    setBusy(false);
    if (res.ok) {
      const { comparisonId } = (await res.json()) as { comparisonId: string };
      router.push(`/w/${slug}/comparisons/${comparisonId}`);
      return;
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; reasons?: string[] } };
    setErrors(json.error?.reasons?.map((r) => t(`reason.${r}` as never)) ?? [json.error?.message ?? t("failed")]);
  };
  const toleranceOk = tolerance.trim() !== "" && Number(tolerance) >= 0 && Number(tolerance) <= 100;
  if (!open) {
    return (
      <button type="button" className={buttonClass("secondary")} onClick={() => setOpen(true)}>
        {t("open")}
      </button>
    );
  }
  return (
    <section aria-label={t("title")} className="flex w-full flex-col gap-3 rounded-card border border-border bg-bg-surface p-4 shadow-e1">
      <h2 className="text-title font-semibold">{t("title")}</h2>
      <Alert tone="info">{t("warning")}</Alert>
      {!choices ? null : choices.environments.length < 2 ? (
        <p className="text-meta">{t("needTwo")}</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          {!choices.hasScreenshotStep && <p className="w-full text-meta text-warn">{t("noScreenshot")}</p>}
          {(["left", "right"] as const).map((side) => (
            <label key={side} className="flex flex-col gap-1 text-meta font-semibold">
              {t(side)}
              <select value={side === "left" ? left : right} onChange={(e) => (side === "left" ? setLeft : setRight)(e.target.value)} className={`${inputClass} w-auto min-w-40`}>
                {choices.environments.map((e) => (
                  <option key={e.id} value={e.id}>{e.name} · {e.baseUrl}</option>
                ))}
              </select>
            </label>
          ))}
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("location")}
            <select value={location} onChange={(e) => setLocation(e.target.value as "server" | "desktop")} className={`${inputClass} w-auto`}>
              <option value="server">{tLocation("server")}</option>
              {choices.desktop && <option value="desktop">{tLocation("desktop")} · {choices.desktop.label}</option>}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-meta font-semibold">
            {t("tolerance")}
            <input inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} aria-describedby="cmp-tolerance-hint" className={`${inputClass} w-24`} />
          </label>
          <p id="cmp-tolerance-hint" className="w-full text-meta text-text-muted">{t("toleranceHint")}</p>
        </div>
      )}
      {errors && (
        <Alert>
          <ul className="list-disc pl-4">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
      <div className="flex gap-2">
        <button type="button" className={buttonClass("primary")} disabled={busy || !choices || !toleranceOk || choices.environments.length < 2} onClick={() => void submit()}>
          {t("submit")}
        </button>
        <button type="button" className={buttonClass("ghost")} onClick={() => setOpen(false)}>
          {t("cancel")}
        </button>
      </div>
    </section>
  );
}
