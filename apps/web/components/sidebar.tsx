import { getTranslations } from "next-intl/server";
import type { Role } from "@defe2end/shared";
import { ChevronsUpDownIcon, ComparisonsIcon, DashboardIcon, MoreIcon, RunsIcon, ScenariosIcon, SchedulesIcon, SettingsIcon } from "./icons";
import { requireActor } from "../lib/page";
import { CreateWorkspace } from "./create-workspace";
import { NavLinks } from "./nav-links";
import { GuardedLink } from "./navigation-guard";
import { SignOutButton } from "./sign-out-button";
import { Avatar, Wordmark } from "./ui";

interface WorkspaceItem {
  name: string;
  slug: string;
  role: Role;
  memberCount: number;
}

export async function Sidebar({
  current,
  workspaces,
  user,
}: {
  current: WorkspaceItem;
  workspaces: WorkspaceItem[];
  user: { name: string; email: string };
}) {
  const t = await getTranslations("common");
  const { isInstanceAdmin } = await requireActor();
  const base = `/w/${current.slug}`;
  const nav = [
    { href: `${base}/dashboard`, label: t("nav.dashboard"), icon: <DashboardIcon /> },
    { href: `${base}/scenarios`, label: t("nav.scenarios"), icon: <ScenariosIcon /> },
    { href: `${base}/runs`, label: t("nav.runs"), icon: <RunsIcon /> },
    { href: `${base}/comparisons`, label: t("nav.comparisons"), icon: <ComparisonsIcon /> },
    { href: `${base}/schedules`, label: t("nav.schedules"), icon: <SchedulesIcon /> },
    { href: `${base}/settings`, label: t("nav.settings"), icon: <SettingsIcon /> },
  ];

  return (
    <aside className="sticky top-0 flex h-screen w-[240px] shrink-0 flex-col border-r border-border bg-bg-subtle px-3 py-5">
      <GuardedLink href="/" className="px-2">
        <Wordmark />
      </GuardedLink>

      <details className="group relative mt-5">
        <summary
          className="flex cursor-pointer list-none items-center gap-3 rounded-card border border-border bg-bg-surface p-2.5 shadow-e1 [&::-webkit-details-marker]:hidden"
          aria-label={t("shell.switchWorkspace")}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-accent text-meta font-semibold text-white">
            {current.name[0]?.toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-semibold">{current.name}</span>
            <span className="block truncate text-meta text-text-muted">
              {t(`roles.${current.role}`)} · {t("shell.members", { count: current.memberCount })}
            </span>
          </span>
          <ChevronsUpDownIcon className="text-text-muted" />
        </summary>
        <ul className="absolute inset-x-0 top-full z-20 mt-1 rounded-card border border-border bg-bg-surface p-1 shadow-e3">
          {workspaces.map((ws) => (
            <li key={ws.slug}>
              <GuardedLink
                href={`/w/${ws.slug}/scenarios`}
                aria-current={ws.slug === current.slug ? "true" : undefined}
                className="flex items-center justify-between gap-2 rounded-control px-2.5 py-2 hover:bg-accent-soft aria-[current]:font-semibold"
              >
                <span className="truncate">{ws.name}</span>
                <span className="text-meta text-text-muted">{t(`roles.${ws.role}`)}</span>
              </GuardedLink>
            </li>
          ))}
          {isInstanceAdmin && (
            <li className="mt-1 border-t border-border pt-1">
              <CreateWorkspace />
            </li>
          )}
        </ul>
      </details>

      <nav className="mt-6" aria-label={t("nav.workspace")}>
        <NavLinks items={nav} />
      </nav>

      <details className="relative mt-auto border-t border-border pt-3">
        <summary
          className="flex cursor-pointer list-none items-center gap-3 rounded-item px-2 py-1.5 hover:bg-accent-soft [&::-webkit-details-marker]:hidden"
          aria-label={t("shell.userMenu")}
        >
          <Avatar name={user.name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-semibold">{user.name}</span>
            <span className="block truncate text-meta text-text-muted">{user.email}</span>
          </span>
          <MoreIcon className="text-text-muted" />
        </summary>
        <div className="absolute inset-x-0 bottom-full z-20 mb-1 rounded-card border border-border bg-bg-surface p-1 shadow-e3">
          <SignOutButton label={t("shell.signOut")} />
        </div>
      </details>
    </aside>
  );
}
