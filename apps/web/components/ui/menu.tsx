"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ghostOut } from "../../app/transitions/ghost-out";

/** A "…" style popover menu; closes on outside click and Escape. */
/** The open menu list; leaves a fading copy when it closes. */
function MenuList({ align, children }: { align: "left" | "right"; children: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    return () => ghostOut(el);
  }, []);
  return (
    <ul ref={ref} role="menu" data-origin={align === "right" ? "top-right" : "top-left"} className={`t-dropdown absolute top-full z-30 mt-1 min-w-[180px] rounded-item border border-border bg-bg-surface p-1 shadow-e3 ${align === "right" ? "right-0" : "left-0"}`}>
      {children}
    </ul>
  );
}

export function Menu({ label, trigger, items, align = "right" }: { label: string; trigger: ReactNode; items: { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="flex size-8 items-center justify-center rounded-control text-text-muted hover:bg-bg-subtle hover:text-text-primary"
      >
        {trigger}
      </button>
      {open && (
        <MenuList align={align}>
          {items.map((item) => (
            <li key={item.label}>
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
                className={`w-full rounded-control px-2.5 py-1.5 text-left text-body hover:bg-bg-subtle disabled:opacity-40 ${item.danger ? "text-fail" : "text-text-primary"}`}
              >
                {item.label}
              </button>
            </li>
          ))}
        </MenuList>
      )}
    </div>
  );
}
