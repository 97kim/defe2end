import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { Alert, Wordmark } from "../../components/ui";
import { getActor } from "../../lib/actor";
import { authProviders } from "../../lib/auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

/** Error codes Better Auth puts on `/login?error=` after an OIDC/GitHub callback. */
const EXTERNAL_ERRORS = new Set(["signup_not_allowed", "account_not_linked"]);

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getActor(await headers())) redirect("/");
  const t = await getTranslations("common");
  const ta = await getTranslations("accounts.externalLogin");
  const { error } = await searchParams;
  const { oidc, github } = authProviders();
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex justify-center">
          <Wordmark />
        </div>
        <div className="rounded-card border border-border bg-bg-surface p-6 shadow-e2">
          <h1 className="mb-5 text-title-md">{t("login.title")}</h1>
          {error && (
            <div className="mb-4">
              <Alert>{EXTERNAL_ERRORS.has(error) ? ta(error as "signup_not_allowed" | "account_not_linked") : ta("failed")}</Alert>
            </div>
          )}
          <LoginForm oidc={oidc && { name: oidc.name, providerId: oidc.providerId }} github={Boolean(github)} />
        </div>
      </div>
    </main>
  );
}
