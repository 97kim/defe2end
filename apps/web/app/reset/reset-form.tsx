"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LinkProblem } from "../../components/accounts/link-page";
import { readTokenFromHash } from "../../components/accounts/link-reveal";
import { Alert, Button, buttonClass, Field, Input } from "../../components/ui";

type Problem = "missing" | "invalid" | "expired" | "used" | "revoked" | "rateLimited";

async function post(body: object) {
  const res = await fetch("/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

export function ResetForm() {
  const t = useTranslations("accounts");
  const [token, setToken] = useState<string>();
  const [email, setEmail] = useState<string>();
  const [problem, setProblem] = useState<Problem>();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  // Read once: the hash is cleared right after, and StrictMode runs effects twice in development.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const fromHash = readTokenFromHash();
    if (!fromHash) return setProblem("missing");
    setToken(fromHash);
    post({ intent: "inspect", token: fromHash }).then(({ status, data }) => {
      if (data?.state === "valid") setEmail(data.email);
      else setProblem(status === 429 ? "rateLimited" : ((data?.state as Problem) ?? "invalid"));
    });
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm"))) return setError(t("reset.mismatch"));
    setPending(true);
    setError(undefined);
    const { status, data } = await post({ intent: "reset", token, password });
    setPending(false);
    if (status === 200) return setDone(true);
    if (data?.error?.state) setProblem(data.error.state);
    else setError(status === 429 ? t("link.rateLimitedBody") : t("reset.failed"));
  }

  const toLogin = (
    <Link href="/login" className={buttonClass("primary")}>
      {t("link.toLogin")}
    </Link>
  );

  if (done) return <LinkProblem title={t("reset.doneTitle")} body={t("reset.doneBody")} action={toLogin} />;
  if (problem) {
    return (
      <LinkProblem
        title={t(`link.${problem}Title`)}
        body={t(`link.${problem}Body`)}
        action={
          <Link href="/login" className={buttonClass("secondary")}>
            {t("link.toLogin")}
          </Link>
        }
      />
    );
  }
  if (!email) return <p className="text-text-muted">{t("link.checking")}</p>;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div>
        <h1 className="text-title-md">{t("reset.title")}</h1>
        <p className="mt-1 text-text-muted">{t("reset.forEmail", { email })}</p>
      </div>
      {/* Lets password managers tie the new password to this account. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <Field label={t("reset.password")}>
        <Input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
      </Field>
      <Field label={t("reset.confirm")}>
        <Input name="confirm" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
      </Field>
      {error && <Alert>{error}</Alert>}
      <Button type="submit" disabled={pending}>
        {pending ? t("reset.submitting") : t("reset.submit")}
      </Button>
    </form>
  );
}
