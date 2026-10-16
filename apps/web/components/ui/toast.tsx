"use client";

import { useTranslations } from "next-intl";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ghostOut } from "../../app/transitions/ghost-out";
import { CloseIcon } from "../icons";

// ds-2 Feedback/Toast: short, non-blocking confirmations bottom-right; each one goes away after 5 s.

export interface ToastItem {
  id: number;
  tone: "ok" | "error";
  text: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(0);
  const dismiss = (id: number) => setToasts((all) => all.filter((t) => t.id !== id));
  const push = (text: string, tone: ToastItem["tone"] = "ok") => {
    const id = ++next.current;
    setToasts((all) => [...all.slice(-2), { id, tone, text }]);
    setTimeout(() => dismiss(id), 5000);
  };
  return { toasts, push, dismiss };
}

export function Toasts({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  const t = useTranslations("common.toast");
  return (
    <div className="pointer-events-none fixed right-6 bottom-6 z-50 flex flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <ToastFrame key={toast.id}>
          <span className={`size-2 shrink-0 rounded-full ${toast.tone === "ok" ? "bg-pass" : "bg-fail"}`} aria-hidden="true" />
          <span className="flex-1 text-body">{toast.text}</span>
          <button type="button" onClick={() => onDismiss(toast.id)} aria-label={t("dismiss")} className="text-text-muted hover:text-text-primary">
            <CloseIcon width={14} height={14} />
          </button>
        </ToastFrame>
      ))}
    </div>
  );
}

/** One toast; leaves a fading copy when dismissed or timed out. */
function ToastFrame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    return () => ghostOut(el);
  }, []);
  return (
    <div ref={ref} className="t-toast pointer-events-auto flex min-w-[280px] items-center gap-3 rounded-item border border-border bg-bg-surface px-3.5 py-2.5 shadow-e3">
      {children}
    </div>
  );
}
