import { DEFAULT_LOCALE, isLocale, messages, type Locale } from "@defe2end/i18n";
import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";

export const LOCALE_COOKIE = "NEXT_LOCALE";

/** No locale in the URL: the cookie wins, then Accept-Language, then English. */
async function detectLocale(): Promise<Locale> {
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  const accept = (await headers()).get("accept-language") ?? "";
  for (const part of accept.split(",")) {
    const lang = part.split(";")[0]?.trim().slice(0, 2).toLowerCase();
    if (isLocale(lang)) return lang;
  }
  return DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = await detectLocale();
  return { locale, messages: messages[locale] };
});
