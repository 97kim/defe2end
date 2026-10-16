"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, type RefObject } from "react";

// Jump to the top / bottom of the editor's scroll area. Hidden near the end they lead to, and both hidden
// when the area doesn't scroll. Sticky inside the area, so the recording panel (fixed, above it) is never covered.

const NEAR = 80;

export function scrollButtons(m: { scrollTop: number; scrollHeight: number; clientHeight: number }, near = NEAR) {
  const scrollable = m.scrollHeight - m.clientHeight > near;
  return { showTop: scrollable && m.scrollTop > near, showBottom: scrollable && m.scrollHeight - m.clientHeight - m.scrollTop > near };
}

export function ScrollButtons({ container, raised }: { container: RefObject<HTMLElement | null>; raised?: boolean }) {
  const t = useTranslations("scenarios.detail");
  const [state, setState] = useState({ showTop: false, showBottom: false });
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const update = () => setState(scrollButtons(el));
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [container]);
  const go = (top: number) => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    container.current?.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
  };
  if (!state.showTop && !state.showBottom) return null;
  const button = "pointer-events-auto flex size-9 items-center justify-center rounded-full border border-border-strong bg-bg-surface text-text-secondary shadow-e2 hover:bg-accent-soft hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  return (
    // Lifted above the toast stack (bottom-right) while toasts are showing.
    <div className={`pointer-events-none sticky z-10 -mt-[76px] flex flex-col items-end gap-2 transition-[bottom] duration-[var(--motion-base)] motion-reduce:transition-none ${raised ? "bottom-24" : "bottom-0"}`}>
      {state.showTop && (
        <button type="button" aria-label={t("toTop")} title={t("toTop")} className={button} onClick={() => go(0)}>
          <span aria-hidden="true">↑</span>
        </button>
      )}
      {state.showBottom && (
        <button type="button" aria-label={t("toBottom")} title={t("toBottom")} className={button} onClick={() => go(container.current?.scrollHeight ?? 0)}>
          <span aria-hidden="true">↓</span>
        </button>
      )}
    </div>
  );
}
