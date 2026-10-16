import type { Locale, Messages } from "@defe2end/i18n";

// Type-checks message keys in useTranslations/getTranslations.
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
