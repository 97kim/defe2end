"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Tabs from ds-2 "Selection controls": page links (Tab/Enter), ink underline on the current one. */
export function Tabs({ label, tabs }: { label: string; tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="flex gap-6 border-b border-border bg-bg-surface px-8">
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 py-3 text-body transition-colors ${
              active ? "border-accent font-semibold text-text-primary" : "border-transparent text-text-secondary hover:text-text-primary"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
