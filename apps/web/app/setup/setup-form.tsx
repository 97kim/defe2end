"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Field, Input } from "../../components/ui";
import { authClient } from "../../lib/auth-client";

export function SetupForm() {
  const t = useTranslations("common.setup");
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  // The token travels in the URL fragment (#token=…) so it never reaches server logs; drop it from the address bar.
  useEffect(() => {
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (fromHash) {
      setToken(fromHash);
      history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setPending(true);
    setError(undefined);
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, token }),
    });
    if (!res.ok) {
      setPending(false);
      setError(res.status === 403 ? t("invalidToken") : t("failed"));
      return;
    }
    const { slug } = (await res.json()) as { slug: string };
    await authClient.signIn.email({ email: form.email!, password: form.password! });
    router.replace(`/w/${slug}/scenarios`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label={t("token")}>
        <Input name="token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required className="font-mono" />
      </Field>
      <Field label={t("name")}>
        <Input name="name" autoComplete="name" required />
      </Field>
      <Field label={t("email")}>
        <Input name="email" type="email" autoComplete="username" required />
      </Field>
      <Field label={t("password")}>
        <Input name="password" type="password" autoComplete="new-password" minLength={8} required />
      </Field>
      <Field label={t("workspaceName")}>
        <Input name="workspaceName" required />
      </Field>
      {error && (
        <p role="alert" className="rounded-control border border-fail/30 bg-fail-soft px-3 py-2 text-meta text-fail">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {t("submit")}
      </Button>
    </form>
  );
}
