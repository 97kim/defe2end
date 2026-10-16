"use client";

import { useTranslations } from "next-intl";
import { Alert, Button } from "../ui";
import { INSTALL_URL, LOGIN_COMMAND, type AiEvent, type Provider, type ProviderState } from "./bridge";

/** Why a provider can't be used (missing or below the checked version), with the install link and a re-check. */
export function ProviderNotices({ states, checking, onRecheck }: { states: ProviderState[] | null; checking: boolean; onRecheck: () => void }) {
  const t = useTranslations("ai");
  if (!states) return <p className="text-meta text-text-muted">{t("status.checking")}</p>;
  const blocked = states.filter((s) => s.state !== "ready");
  if (blocked.length === 0) return null;
  const none = blocked.length === states.length;
  return (
    <div className="flex flex-col gap-2">
      {none && <Alert tone="info">{t("status.none")}</Alert>}
      {blocked.map((s) => (
        <p key={s.provider} className="text-meta text-text-secondary">
          {s.state === "unsupported"
            ? t("status.unsupported", { provider: t(`provider.${s.provider}`), version: s.version, minVersion: s.minVersion })
            : t("status.missing", { provider: t(`provider.${s.provider}`) })}{" "}
          <a href={INSTALL_URL[s.provider]} target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">
            {t("status.install")}
          </a>
        </p>
      ))}
      <div>
        <Button type="button" variant="secondary" onClick={onRecheck} disabled={checking}>
          {t("status.recheck")}
        </Button>
      </div>
    </div>
  );
}

/** The message for a failed turn: expired login gets the terminal command. */
export function useTurnErrorText(): (provider: Provider, event: Extract<AiEvent, { type: "error" }>) => string {
  const t = useTranslations("ai");
  return (provider, event) => {
    const name = t(`provider.${provider}`);
    if (event.code === "auth") return t("error.auth", { provider: name, command: LOGIN_COMMAND[provider] });
    if (event.code === "missing") return t("error.missing", { provider: name });
    if (event.code === "stopped") return t("error.stopped");
    if (event.code === "unsafe") return t("error.unsafe", { provider: name });
    return t("error.failed", { provider: name, message: event.message.slice(0, 300) });
  };
}

const REFUSALS = ["stopped", "unsafe_cli", "provider_unavailable", "provider_locked", "busy", "too_many_images", "image_too_large", "bad_image", "empty", "too_long", "unknown_provider", "invalid"] as const;
export function useRefusalText(): (reason: string) => string {
  const t = useTranslations("ai");
  return (reason) => t(`error.refused.${(REFUSALS as readonly string[]).includes(reason) ? (reason as (typeof REFUSALS)[number]) : "invalid"}`);
}
