import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { CloseIcon, EyeIcon } from "./icons";

// Shared atoms from design/export/ds-2-components.png. Extend here instead of restyling per page.
// Pieces with client state live in ./ui/ and are re-exported here, so every page imports from one place.
export { Dialog } from "./ui/dialog";
export { Menu } from "./ui/menu";
export { Tabs } from "./ui/tabs";
export { Toasts, useToasts, type ToastItem } from "./ui/toast";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-white shadow-e1 hover:bg-accent-hover",
  secondary: "border border-border-strong bg-bg-surface text-text-primary shadow-e1 hover:bg-bg-subtle",
  ghost: "text-text-secondary hover:bg-accent-soft hover:text-text-primary",
  danger: "bg-fail text-white shadow-e1 hover:brightness-90",
};

export function buttonClass(variant: Variant = "primary", extra = ""): string {
  return `inline-flex h-9 items-center justify-center gap-2 rounded-control px-3.5 text-body font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40 ${VARIANTS[variant]} ${extra}`;
}

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button className={buttonClass(variant, className)} {...props} />;
}

export const inputClass =
  "h-9 w-full rounded-control border border-border-strong bg-bg-surface px-3 text-body text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:bg-bg-subtle aria-invalid:border-fail";

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-meta font-semibold text-text-primary">{label}</span>
      {/* error-state-shake: runs once when an error appears (the class is added); no remount, so focus stays. */}
      <div className={`t-input flex flex-col${error ? " is-shaking" : ""}`}>{children}</div>
      {error ? <span className="text-meta text-fail">{error}</span> : hint ? <span className="text-meta text-text-muted">{hint}</span> : null}
    </label>
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${inputClass} ${className}`} {...props} />;
}

/** ds-2 "Alert": error tint for failures, neutral for info. */
export function Alert({ tone = "error", children }: { tone?: "error" | "info"; children: ReactNode }) {
  const cls = tone === "error" ? "border-fail/30 bg-fail-soft text-fail" : "border-border bg-bg-subtle text-text-secondary";
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`rounded-control border px-3 py-2 text-meta ${cls}`}>
      {children}
    </p>
  );
}

/** ds-2 Toggle: a switch (Space/Enter) with its label; ink track when on. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={`inline-flex items-center gap-2 text-body ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}>
      {/* Track 36×20 with 2px inner padding; the 16px knob sits inside it, moved by exactly 16px (36 − 2·2 − 16). */}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`flex h-5 w-9 shrink-0 items-center rounded-full p-[2px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed ${
          checked ? "bg-accent" : "bg-border-strong hover:bg-text-muted/50"
        }`}
      >
        <span className={`block size-4 rounded-full bg-white shadow-e1 transition-transform ${checked ? "translate-x-4" : "translate-x-0"}`} />
      </button>
      {label}
    </label>
  );
}

/** ds-2 Chip/Filter: a pressed-state toggle button. */
export function Chip({ active, disabled, title, onClick, children, mono }: { active?: boolean; disabled?: boolean; title?: string; onClick?: () => void; children: ReactNode; mono?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-body transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active ? "border-border-strong bg-accent-soft font-semibold text-text-primary" : "border-border bg-bg-surface text-text-secondary hover:bg-bg-subtle"
      } ${mono ? "font-mono text-code" : ""}`}
    >
      {children}
    </button>
  );
}

/** ds-2 Tag: mono label, optionally removable. */
export function Tag({ children, onRemove, removeLabel }: { children: ReactNode; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-tag border border-border bg-bg-subtle px-1.5 font-mono text-code-sm text-text-secondary">
      {children}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={removeLabel} className="-mr-0.5 rounded text-text-muted hover:text-text-primary">
          <CloseIcon width={11} height={11} />
        </button>
      )}
    </span>
  );
}

/** s-5 viewer treatment: a neutral banner explaining why the controls are missing. */
export function ViewOnlyBanner({ title, body }: { title: string; body: string }) {
  return (
    <div role="note" className="flex gap-3 rounded-card border border-border bg-bg-subtle px-5 py-4">
      <EyeIcon className="mt-0.5 shrink-0 text-text-secondary" />
      <div>
        <p className="font-semibold text-text-primary">{title}</p>
        <p className="text-text-secondary">{body}</p>
      </div>
    </div>
  );
}

/** Logo: "def" + "E2E" in an ink chip + "nd". Never redraw it. */
export function Wordmark({ size = "md" }: { size?: "md" | "lg" }) {
  const lg = size === "lg";
  return (
    <span className={`inline-flex items-center font-semibold tracking-tight text-text-primary ${lg ? "text-[40px]" : "text-[20px]"}`}>
      def
      <span className={`mx-0.5 rounded-[5px] bg-accent px-1 leading-tight text-white ${lg ? "rounded-[10px] px-2" : ""}`}>E2E</span>
      nd
    </span>
  );
}

/** Top bar of a workspace page: breadcrumb + title on the left, actions on the right. */
export function PageHeader({ crumbs, title, actions }: { crumbs: string[]; title: string; actions?: ReactNode }) {
  return (
    <header className="flex min-h-[88px] items-center justify-between gap-4 border-b border-border bg-bg-surface px-8">
      <div className="min-w-0">
        <nav className="flex items-center gap-1.5 text-meta text-text-muted" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden="true">›</span>}
              {c}
            </span>
          ))}
        </nav>
        <h1 className="truncate text-title-lg">{title}</h1>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 rounded-card border border-border bg-bg-surface px-8 py-12 text-center shadow-e1">
      <p className="text-title-sm">{title}</p>
      {body && <p className="text-text-muted">{body}</p>}
      {children && <div className="mt-3 flex gap-2">{children}</div>}
    </div>
  );
}

export function Avatar({ name, className = "" }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-bg-subtle text-meta font-semibold text-text-secondary ${className}`}>
      {initials || "?"}
    </span>
  );
}
