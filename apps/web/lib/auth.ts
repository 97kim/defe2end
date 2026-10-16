import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";
import { externalSignupAllowed } from "./accounts/signup-policy";
import { getDb } from "./db";

const DISCOVERY_SUFFIX = "/.well-known/openid-configuration";

/** OIDC discovery lives at `<issuer>/.well-known/openid-configuration` (OpenID Connect Discovery 1.0 §4). */
function issuerFromDiscoveryUrl(url: string): string | undefined {
  const trimmed = url.trim();
  return trimmed.endsWith(DISCOVERY_SUFFIX) ? trimmed.slice(0, -DISCOVERY_SUFFIX.length).replace(/\/+$/, "") : undefined;
}

/**
 * Better Auth keys external accounts by `providerId + accountId`. Deriving the provider id from the issuer
 * makes that key issuer + subject (contract section 1): pointing OIDC at another issuer can never map its
 * subjects onto accounts created by the old one.
 */
export function oidcProviderId(issuer: string): string {
  return `oidc-${createHash("sha256").update(issuer).digest("hex").slice(0, 16)}`;
}

/** OIDC and GitHub sign-in are on only when their env vars are set. */
export function authProviders() {
  const env = process.env;
  const issuer = env.OIDC_DISCOVERY_URL ? issuerFromDiscoveryUrl(env.OIDC_DISCOVERY_URL) : undefined;
  if (env.OIDC_DISCOVERY_URL && !issuer) {
    console.error(`OIDC sign-in is off: OIDC_DISCOVERY_URL must end with ${DISCOVERY_SUFFIX}`);
  }
  const oidc =
    issuer && env.OIDC_CLIENT_ID
      ? {
          discoveryUrl: env.OIDC_DISCOVERY_URL!,
          issuer,
          providerId: oidcProviderId(issuer),
          clientId: env.OIDC_CLIENT_ID,
          clientSecret: env.OIDC_CLIENT_SECRET,
          name: env.OIDC_PROVIDER_NAME || "OIDC",
        }
      : undefined;
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
      : undefined;
  return { oidc, github };
}

function createAuth() {
  const { oidc, github } = authProviders();
  return betterAuth({
    appName: "defE2End",
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    database: prismaAdapter(getDb(), { provider: "postgresql" }),
    // Sign-up is invite-only: accounts are created by our code (lib/users.ts), never by the public endpoint.
    // External sign-ins never create users implicitly either.
    emailAndPassword: { enabled: true, disableSignUp: true },
    socialProviders: github ? { github: { ...github, disableImplicitSignUp: true } } : {},
    // Never merge a local account with an OIDC/GitHub account because the email matches.
    account: { accountLinking: { enabled: false } },
    // On in every environment (Better Auth enables it only in production by default).
    rateLimit: { enabled: true, storage: "database" },
    user: {
      additionalFields: {
        isInstanceAdmin: { type: "boolean", defaultValue: false, input: false },
        disabledAt: { type: "date", required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Our own code (setup, invites) creates users outside any Better Auth endpoint and enforces its own rules.
          // Anything created through an endpoint is an external sign-in: `disableImplicitSignUp` can be lifted by
          // the client (`requestSignUp`), so this hook is the gate.
          before: async (user, context) => {
            if (!context) return;
            if (!(await externalSignupAllowed(user))) {
              throw new APIError("FORBIDDEN", { code: "signup_not_allowed", message: "Ask an admin for an invite" });
            }
          },
        },
      },
      session: {
        create: {
          // Disabled users cannot sign in.
          before: async (session) => {
            const user = await getDb().user.findUnique({ where: { id: session.userId }, select: { disabledAt: true } });
            return user && !user.disabledAt ? undefined : false;
          },
        },
      },
    },
    plugins: oidc
      ? [
          genericOAuth({
            config: [
              {
                providerId: oidc.providerId,
                name: oidc.name,
                discoveryUrl: oidc.discoveryUrl,
                clientId: oidc.clientId,
                clientSecret: oidc.clientSecret,
                scopes: ["openid", "email", "profile"],
                pkce: true,
                disableImplicitSignUp: true,
                // The id token must verify against the discovery JWKS and issuer…
                requireIdTokenVerification: true,
                // …and that issuer must be the configured one, so the provider id above really names it.
                mapProfileToUser: (profile: Record<string, unknown>) => {
                  if (typeof profile.iss !== "string" || profile.iss.replace(/\/+$/, "") !== oidc.issuer) {
                    throw new APIError("UNAUTHORIZED", { code: "issuer_mismatch", message: "Unexpected OIDC issuer" });
                  }
                  return {};
                },
              },
            ],
          }),
        ]
      : [],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as { auth?: Auth };

/** Created on first use so `next build` doesn't need runtime env vars. */
export function getAuth(): Auth {
  return (globalForAuth.auth ??= createAuth());
}
