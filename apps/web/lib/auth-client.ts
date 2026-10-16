"use client";

import { createAuthClient } from "better-auth/react";

/** Factory for tests (custom fetch); the app uses `authClient`. */
export function makeAuthClient(options?: Parameters<typeof createAuthClient>[0]) {
  return createAuthClient(options);
}

export const authClient = makeAuthClient();

/**
 * What the login page's OIDC/GitHub buttons send. The page always asks for sign-up: the server hook decides
 * (invite or self-signup domain, verified email), and refusals come back as `/login?error=…`.
 */
export const LOGIN_PAGE_EXTERNAL_SIGN_IN = { callbackURL: "/", errorCallbackURL: "/login", requestSignUp: true };

/**
 * Starts an OIDC or GitHub login. Better Auth registers the generic OIDC provider as a social provider,
 * so both go through `/sign-in/social`. `requestSignUp` only asks: the server still creates the account
 * only for an invited or self-signup-domain verified email (lib/accounts/signup-policy.ts).
 */
export function startExternalSignIn(
  provider: string,
  opts: { callbackURL: string; errorCallbackURL?: string; requestSignUp?: boolean; disableRedirect?: boolean },
  client: Pick<ReturnType<typeof makeAuthClient>, "signIn"> = authClient,
) {
  return client.signIn.social({ provider, ...opts });
}
