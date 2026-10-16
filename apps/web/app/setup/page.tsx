import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Wordmark } from "../../components/ui";
import { isSetupDone } from "../../lib/setup";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isSetupDone()) notFound();
  const t = await getTranslations("common");
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex justify-center">
          <Wordmark />
        </div>
        <div className="rounded-card border border-border bg-bg-surface p-6 shadow-e2">
          <h1 className="text-title-md">{t("setup.title")}</h1>
          <p className="mb-5 mt-1 text-text-muted">{t("setup.description")}</p>
          <SetupForm />
        </div>
      </div>
    </main>
  );
}
