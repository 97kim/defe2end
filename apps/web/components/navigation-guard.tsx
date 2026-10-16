"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ComponentProps } from "react";
import { guardNavigation, hasUnsavedChanges, isPlainClick, setLeavePrompt } from "../lib/navigation-guard";
import type { LeaveChoice } from "../lib/scenario-helpers";
import { Button, Dialog } from "./ui";

/** Mount once (workspace layout): renders the "Unsaved changes" dialog for `guardNavigation()`. */
export function NavigationGuardHost() {
  const t = useTranslations("common.unsaved");
  const [pending, setPending] = useState<((choice: LeaveChoice) => void) | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(
    () =>
      setLeavePrompt({
        ask: () =>
          new Promise<LeaveChoice>((resolve) => {
            setSaving(false);
            setPending(() => (choice: LeaveChoice) => {
              // "Save and continue" keeps the dialog up (buttons disabled) until settle().
              if (choice === "save") setSaving(true);
              resolve(choice);
            });
          }),
        settle: () => {
          setPending(null);
          setSaving(false);
        },
      }),
    [],
  );

  if (!pending) return null;
  return (
    <Dialog
      title={t("title")}
      onClose={() => pending("cancel")}
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={() => pending("cancel")}>
            {t("cancel")}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={() => pending("discard")}>
            {t("discard")}
          </Button>
          <Button autoFocus disabled={saving} onClick={() => pending("save")}>
            {t("save")}
          </Button>
        </>
      }
    >
      <p className="text-text-secondary">{t("body")}</p>
    </Dialog>
  );
}

/** next/link that asks before leaving unsaved edits (plain clicks only). */
export function GuardedLink({ href, onClick, ...props }: ComponentProps<typeof Link> & { href: string }) {
  const router = useRouter();
  return (
    <Link
      href={href}
      {...props}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || !isPlainClick(e) || !hasUnsavedChanges()) return;
        e.preventDefault();
        void guardNavigation(() => router.push(href));
      }}
    />
  );
}
