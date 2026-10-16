"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { GuardedLink } from "./navigation-guard";

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
}

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <GuardedLink
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex h-9 items-center gap-3 rounded-item px-3 text-[14px] transition-colors ${
                active ? "bg-selected font-semibold text-text-primary" : "text-text-secondary hover:bg-accent-soft hover:text-text-primary"
              }`}
            >
              {item.icon}
              {item.label}
            </GuardedLink>
          </li>
        );
      })}
    </ul>
  );
}
