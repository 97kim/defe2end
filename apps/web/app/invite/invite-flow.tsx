"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LinkProblem } from "../../components/accounts/link-page";
import { readTokenFromHash } from "../../components/accounts/link-reveal";
import { Alert, Button, buttonClass, Field, Input } from "../../components/ui";
import { authClient, startExternalSignIn } from "../../lib/auth-client";

type Problem = "missing" | "invalid" | "expired" | "used" | "revoked" | "rateLimited";
interface InviteInfo {
  email: string;
  role: "ADMIN" | "EDITOR" | "VIEWER";
  workspace: string;
  hasAccount: boolean;
}

// Survives the round trip to an external sign-in (same tab only); cleared once the invite is used or dead.
const PENDING_TOKEN_KEY = "defe2end.inviteToken";

async function post(body: object) {
  const res = await fetch("/api/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

export function InviteFlow({ signedInEmail, external }: { signedInEmail: string | null; external: { id: string; name: string }[] }) {
  const t = useTranslations("accounts");
  const tc = useTranslations("common");
  const router = useRouter();
  const [token, setToken] = useState<string>();
  const [info, setInfo] = useState<InviteInfo>();
  const [problem, setProblem] = useState<Problem | "wrong_account">();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  // Read once: the hash is cleared right after, and StrictMode runs effects twice in development.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const fromHash = readTokenFromHash() ?? sessionStorage.getItem(PENDING_TOKEN_KEY);
    if (new URLSearchParams(window.location.search).has("error")) {
      setError(t("accept.externalFailed"));
      history.replaceState(null, "", window.location.pathname);
    }
    if (!fromHash) return setProblem("missing");
    setToken(fromHash);
    post({ intent: "inspect", token: fromHash }).then(({ status, data }) => {
      if (data?.state === "valid") setInfo(data);
      else {
        sessionStorage.removeItem(PENDING_TOKEN_KEY);
        setProblem(status === 429 ? "rateLimited" : ((data?.state as Problem) ?? "invalid"));
      }
    });
  }, [t]);

  function continueWith(provider: string) {
    sessionStorage.setItem(PENDING_TOKEN_KEY, token!);
    // requestSignUp only asks; the server creates the account only for a verified email with this invite.
    startExternalSignIn(provider, { callbackURL: "/invite", errorCallbackURL: "/invite", requestSignUp: true });
  }

  /** Handles an accept/signup response; link problems switch to the matching page. */
  function finish({ status, data }: { status: number; data: any }) {
    if (status < 300 && data?.slug) {
      sessionStorage.removeItem(PENDING_TOKEN_KEY);
      router.replace(`/w/${data.slug}/scenarios`);
      router.refresh();
      return true;
    }
    if (data?.error?.state) {
      if (data.error.state !== "wrong_account") sessionStorage.removeItem(PENDING_TOKEN_KEY);
      setProblem(data.error.state);
    } else setError(status === 429 ? t("link.rateLimitedBody") : status === 409 ? t("accept.accountExists") : t("accept.failed"));
    return false;
  }

  async function accept() {
    setPending(true);
    setError(undefined);
    const ok = finish(await post({ intent: "accept", token }));
    if (!ok) setPending(false);
  }

  async function signInAndAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    setPending(true);
    setError(undefined);
    const { error } = await authClient.signIn.email({ email: info!.email, password });
    if (error) {
      setPending(false);
      setError(error.status === 429 ? t("accept.rateLimited") : t("accept.signInFailed"));
      return;
    }
    if (!finish(await post({ intent: "accept", token }))) setPending(false);
  }

  async function createAndAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    setPending(true);
    setError(undefined);
    const res = await post({ intent: "signup", token, name: String(form.get("name")), password });
    if (res.status !== 201) {
      setPending(false);
      finish(res);
      return;
    }
    await authClient.signIn.email({ email: info!.email, password });
    finish(res);
  }

  if (problem && problem !== "wrong_account") {
    return (
      <LinkProblem
        title={t(`link.${problem}Title`)}
        body={t(`link.${problem}Body`)}
        action={
          <Link href="/" className={buttonClass("secondary")}>
            {t("link.backHome")}
          </Link>
        }
      />
    );
  }
  if (!info) return <p className="text-text-muted">{t("link.checking")}</p>;

  const header = (
    <div className="mb-5">
      <h1 className="text-title-md">{t("accept.title", { workspace: info.workspace })}</h1>
      <p className="mt-1 text-text-muted">{t("accept.summary", { workspace: info.workspace, role: tc(`roles.${info.role}`) })}</p>
    </div>
  );
  const errorBox = error && <Alert>{error}</Alert>;
  const externalButtons = external.length > 0 && (
    <>
      <div className="flex items-center gap-3 text-meta text-text-muted">
        <span className="h-px flex-1 bg-border" />
        {t("accept.or")}
        <span className="h-px flex-1 bg-border" />
      </div>
      {external.map((p) => (
        <Button key={p.id} variant="secondary" type="button" disabled={pending} onClick={() => continueWith(p.id)}>
          {t("accept.continueWith", { provider: p.name })}
        </Button>
      ))}
      <p className="text-meta text-text-muted">{t("accept.externalHint", { email: info.email })}</p>
    </>
  );

  if (problem === "wrong_account" || (signedInEmail && signedInEmail.toLowerCase() !== info.email)) {
    return (
      <LinkProblem
        title={t("accept.wrongTitle")}
        body={t("accept.wrongBody", { current: signedInEmail ?? "", email: info.email })}
        action={
          <Button
            variant="secondary"
            type="button"
            onClick={async () => {
              await authClient.signOut();
              setProblem(undefined);
              router.refresh();
            }}
          >
            {t("accept.signOut")}
          </Button>
        }
      />
    );
  }

  if (signedInEmail) {
    return (
      <div>
        {header}
        <div className="flex flex-col gap-4">
          <Alert tone="info">{t("accept.signedInAs", { email: signedInEmail })}</Alert>
          {errorBox}
          <Button type="button" onClick={accept} disabled={pending}>
            {pending ? t("accept.joining") : t("accept.join")}
          </Button>
        </div>
      </div>
    );
  }

  if (info.hasAccount) {
    return (
      <div>
        {header}
        <form onSubmit={signInAndAccept} className="flex flex-col gap-4">
          <p className="text-meta text-text-secondary">{t("accept.signInBody", { email: info.email })}</p>
          <Field label={t("invites.email")}>
            <Input name="email" type="email" value={info.email} readOnly autoComplete="username" />
          </Field>
          <Field label={t("accept.password")}>
            <Input name="password" type="password" autoComplete="current-password" required />
          </Field>
          {errorBox}
          <Button type="submit" disabled={pending}>
            {pending ? t("accept.joining") : t("accept.signIn")}
          </Button>
          {externalButtons}
        </form>
      </div>
    );
  }

  return (
    <div>
      {header}
      <form onSubmit={createAndAccept} className="flex flex-col gap-4">
        <h2 className="text-title-sm">{t("accept.createTitle")}</h2>
        <Field label={t("invites.email")} hint={t("accept.createBody", { email: info.email })}>
          <Input name="email" type="email" value={info.email} readOnly autoComplete="username" />
        </Field>
        <Field label={t("accept.name")}>
          <Input name="name" autoComplete="name" required maxLength={100} />
        </Field>
        <Field label={t("accept.newPassword")}>
          <Input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
        </Field>
        {errorBox}
        <Button type="submit" disabled={pending}>
          {pending ? t("accept.joining") : t("accept.create")}
        </Button>
        {externalButtons}
      </form>
    </div>
  );
}
