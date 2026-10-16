// The AI diagnosis consent as the diagnosis panel sees it (stage 6 contract section 8): only the server's value counts.

export const CONSENT_URL = "/api/account/ai-diagnosis-consent";
/** Where the consent once lived in the browser. Not tied to an account, so it is dropped, never moved. */
export const LEGACY_CONSENT_KEY = "defe2end.ai.diagnosisConsent";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function recordConsent(fetcher: Fetch = fetch): Promise<boolean> {
  const res = await fetcher(CONSENT_URL, { method: "POST" }).catch(() => null);
  return !!res?.ok;
}

/** Whether the signed-in user has agreed, asked fresh from the server. Any failure counts as "not yet". */
export async function hasConsent(fetcher: Fetch = fetch, storage: Pick<Storage, "removeItem"> | undefined = globalThis.localStorage): Promise<boolean> {
  storage?.removeItem(LEGACY_CONSENT_KEY);
  const res = await fetcher(CONSENT_URL, { cache: "no-store" }).catch(() => null);
  if (!res?.ok) return false;
  const body = (await res.json().catch(() => null)) as { consentedAt?: unknown } | null;
  return typeof body?.consentedAt === "string";
}
