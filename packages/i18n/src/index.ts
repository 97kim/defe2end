// Messages are split by namespace so feature teams edit only their own file.
// Use them as `useTranslations("<namespace>")`, e.g. `useTranslations("scenarios")`.
import enAccounts from "./messages/en/accounts.json" with { type: "json" };
import enAi from "./messages/en/ai.json" with { type: "json" };
import enCommon from "./messages/en/common.json" with { type: "json" };
import enComparisons from "./messages/en/comparisons.json" with { type: "json" };
import enRecorder from "./messages/en/recorder.json" with { type: "json" };
import enRuns from "./messages/en/runs.json" with { type: "json" };
import enScenarios from "./messages/en/scenarios.json" with { type: "json" };
import enSchedules from "./messages/en/schedules.json" with { type: "json" };
import enSettings from "./messages/en/settings.json" with { type: "json" };
import koAccounts from "./messages/ko/accounts.json" with { type: "json" };
import koAi from "./messages/ko/ai.json" with { type: "json" };
import koCommon from "./messages/ko/common.json" with { type: "json" };
import koComparisons from "./messages/ko/comparisons.json" with { type: "json" };
import koRecorder from "./messages/ko/recorder.json" with { type: "json" };
import koRuns from "./messages/ko/runs.json" with { type: "json" };
import koScenarios from "./messages/ko/scenarios.json" with { type: "json" };
import koSchedules from "./messages/ko/schedules.json" with { type: "json" };
import koSettings from "./messages/ko/settings.json" with { type: "json" };

export const LOCALES = ["en", "ko"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

const en = { common: enCommon, accounts: enAccounts, settings: enSettings, scenarios: enScenarios, runs: enRuns, recorder: enRecorder, schedules: enSchedules, ai: enAi, comparisons: enComparisons };

/** English is the source of truth; every other locale must have the same keys (see messages.test.ts). */
export type Messages = typeof en;
export type Namespace = keyof Messages;

export const messages: Record<Locale, Messages> = {
  en,
  ko: { common: koCommon, accounts: koAccounts, settings: koSettings, scenarios: koScenarios, runs: koRuns, recorder: koRecorder, schedules: koSchedules, ai: koAi, comparisons: koComparisons },
};

export function isLocale(value: string | undefined): value is Locale {
  return (LOCALES as readonly string[]).includes(value ?? "");
}
