"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../lib/api-client";
import { guardNavigation } from "../lib/navigation-guard";
import { Alert, Button, buttonClass, Dialog, Field, Input } from "./ui";

/** "Create workspace" for instance admins: a trigger plus its dialog. Opens the new workspace on success. */
export function CreateWorkspace({ variant = "menu" }: { variant?: "menu" | "primary" }) {
  const t = useTranslations("settings.workspaces");
  const ta = useTranslations("settings.actions");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  function close() {
    setOpen(false);
    setName("");
    setError(undefined);
  }

  async function submit() {
    if (!name.trim()) return setError(t("nameRequired"));
    setPending(true);
    const res = await api<{ slug: string }>("/api/workspaces", "POST", { name });
    setPending(false);
    if (!res.ok) return setError(t("failed"));
    router.push(`/w/${res.data!.slug}/scenarios`);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        // Creating opens the new workspace, so unsaved edits are settled first.
        onClick={() => void guardNavigation(() => setOpen(true))}
        className={variant === "primary" ? buttonClass("primary") : "flex w-full items-center rounded-control px-2.5 py-2 text-left text-text-secondary hover:bg-accent-soft hover:text-text-primary"}
      >
        {variant === "primary" ? t("create") : `+ ${t("create")}`}
      </button>
      <Dialog
        open={open}
        title={t("createTitle")}
        onClose={close}
        onSubmit={() => void submit()}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={close}>
              {ta("cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? ta("saving") : t("submit")}
            </Button>
          </>
        }
      >
        <Field label={t("name")} hint={t("nameHint")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
        </Field>
        {error && <Alert>{error}</Alert>}
      </Dialog>
    </>
  );
}
