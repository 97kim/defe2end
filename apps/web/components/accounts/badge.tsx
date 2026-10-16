import type { ReactNode } from "react";

/** Neutral label chip (roles, "You", "Disabled"). */
export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "fail"; children: ReactNode }) {
  const cls = tone === "fail" ? "border-fail/30 bg-fail-soft text-fail" : "border-border bg-bg-subtle text-text-secondary";
  return <span className={`inline-flex items-center whitespace-nowrap rounded-tag border px-2 py-0.5 text-meta font-medium ${cls}`}>{children}</span>;
}
