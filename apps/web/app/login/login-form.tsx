"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "../../components/ui";
import { authClient, LOGIN_PAGE_EXTERNAL_SIGN_IN, startExternalSignIn } from "../../lib/auth-client";

export function LoginForm({ oidc, github }: { oidc?: { name: string; providerId: string }; github: boolean }) {
  const t = useTranslations("common.login");
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(undefined);
    const { error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (error) {
      setError(error.status === 429 ? t("rateLimited") : error.status === 401 ? t("invalid") : t("failed"));
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label={t("email")}>
          <Input name="email" type="email" autoComplete="username" required />
        </Field>
        <Field label={t("password")}>
          <Input name="password" type="password" autoComplete="current-password" required />
        </Field>
        {error && (
          <p role="alert" className="rounded-control border border-fail/30 bg-fail-soft px-3 py-2 text-meta text-fail">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? t("submitting") : t("submit")}
        </Button>
      </form>
      {(oidc || github) && (
        <>
          <div className="flex items-center gap-3 text-meta text-text-muted">
            <span className="h-px flex-1 bg-border" />
            {t("or")}
            <span className="h-px flex-1 bg-border" />
          </div>
          {oidc && (
            <Button variant="secondary" type="button" onClick={() => startExternalSignIn(oidc.providerId, LOGIN_PAGE_EXTERNAL_SIGN_IN)}>
              {t("continueWith", { provider: oidc.name })}
            </Button>
          )}
          {github && (
            <Button variant="secondary" type="button" onClick={() => startExternalSignIn("github", LOGIN_PAGE_EXTERNAL_SIGN_IN)}>
              {t("continueWith", { provider: "GitHub" })}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
