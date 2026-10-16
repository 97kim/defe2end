import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Role } from "@defe2end/shared";
import { ArrowRightIcon, LockIcon } from "./icons";
import { buttonClass } from "./ui";

/**
 * S6 "no access" view. `kind="not_found"` never names the workspace (existence must not leak);
 * `kind="forbidden"` is for members whose role is too low.
 */
export async function AccessDenied({
  kind,
  workspaces,
}: {
  kind: "not_found" | "forbidden";
  workspaces?: { name: string; slug: string; role: Role }[];
}) {
  const t = await getTranslations("common");
  const prefix = kind === "not_found" ? "notFound" : "forbidden";
  return (
    <div className="mx-auto flex max-w-[560px] flex-col gap-4 px-6 py-24">
      <span className="flex size-12 items-center justify-center rounded-card border border-border bg-bg-surface shadow-e1">
        <LockIcon width={22} height={22} />
      </span>
      <p className="mt-4 font-mono text-code uppercase tracking-wider text-text-muted">{t(`errors.${prefix}Code`)}</p>
      <h1 className="text-display">{t(`errors.${prefix}Title`)}</h1>
      <p className="text-[15px] leading-relaxed text-text-secondary">{t(`errors.${prefix}Body`)}</p>
      <div className="mt-2">
        <Link href="/" className={buttonClass("primary")}>
          {t("errors.backHome")}
        </Link>
      </div>
      {workspaces && (
        <section className="mt-8 overflow-hidden rounded-card border border-border bg-bg-surface shadow-e1">
          <h2 className="border-b border-border px-5 py-3 text-label uppercase tracking-wider text-text-muted">
            {t("errors.workspacesYouCanOpen")}
          </h2>
          {workspaces.length === 0 ? (
            <p className="px-5 py-4 text-text-muted">{t("errors.noWorkspaces")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {workspaces.map((ws) => (
                <li key={ws.slug}>
                  <Link href={`/w/${ws.slug}/scenarios`} className="flex items-center gap-3 px-5 py-3 hover:bg-bg-subtle">
                    <span className="flex size-7 items-center justify-center rounded-control border border-border bg-bg-subtle text-meta font-semibold">
                      {ws.name[0]?.toUpperCase()}
                    </span>
                    <span className="flex-1 font-semibold">{ws.name}</span>
                    <span className="rounded-tag bg-bg-subtle px-2 py-0.5 text-meta text-text-secondary">{t(`roles.${ws.role}`)}</span>
                    <ArrowRightIcon className="text-text-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
