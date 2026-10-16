// OIDC/GitHub accounts: who may be created, how the identity is keyed, and invite acceptance with an external login.
// Runs the real Better Auth handler against a fake OpenID provider (lib/accounts/testing/fake-oidc.ts).
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { describeDb, resetDatabase } from "../../test/db";
import { callRoute, workspaceWithRoles } from "../../test/helpers";
import { authProviders, getAuth } from "../auth";
import { LOGIN_PAGE_EXTERNAL_SIGN_IN, makeAuthClient, startExternalSignIn } from "../auth-client";
import { getDb } from "../db";
import * as inviteRoute from "../../app/api/invite/route";
import { createInvite } from "./invites";
import { cookieHeader, startFakeOidc, type FakeOidc } from "./testing/fake-oidc";

const BASE = process.env.BETTER_AUTH_URL!;
const CLIENT_ID = "defe2end-test";
const providers: FakeOidc[] = [];

/** Points the app at `idp` and rebuilds the Better Auth instance (it reads env once). */
function useProvider(idp: FakeOidc) {
  process.env.OIDC_DISCOVERY_URL = idp.discoveryUrl;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = "test-secret";
  (globalThis as { auth?: unknown }).auth = undefined;
}

async function newProvider(issuerOverride?: string) {
  const idp = await startFakeOidc({ clientId: CLIENT_ID, issuerOverride });
  providers.push(idp);
  return idp;
}

const providerId = () => authProviders().oidc!.providerId;

/** Full browser round trip: sign-in/social → provider → callback. Returns the session cookie when signed in. */
async function oidcLogin(
  idp: FakeOidc,
  claims: Parameters<FakeOidc["nextLogin"]>[0],
  opts: { requestSignUp?: boolean; callbackURL?: string; errorCallbackURL?: string } = {},
) {
  const auth = getAuth();
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({
        provider: providerId(),
        callbackURL: opts.callbackURL ?? "/after",
        errorCallbackURL: opts.errorCallbackURL ?? "/login",
        requestSignUp: opts.requestSignUp,
        disableRedirect: true,
      }),
    }),
  );
  expect(start.status).toBe(200);
  const authorize = new URL(((await start.json()) as { url: string }).url);
  expect(authorize.origin).toBe(idp.url);
  const { code } = (await (await fetch(`${idp.url}/authorize${authorize.search}`)).json()) as { code: string };
  idp.nextLogin(claims);
  const callback = await auth.handler(
    new Request(`${BASE}/api/auth/callback/${providerId()}?code=${code}&state=${authorize.searchParams.get("state")}`, {
      headers: { cookie: cookieHeader(start) },
    }),
  );
  const cookie = cookieHeader(callback);
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  return { session, cookie, location: callback.headers.get("location") ?? "" };
}

beforeEach(async () => {
  await resetDatabase();
  await getDb().instanceSetting.create({ data: { id: 1 } });
});

afterEach(() => {
  delete process.env.OIDC_DISCOVERY_URL;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  (globalThis as { auth?: unknown }).auth = undefined;
});

afterAll(async () => {
  await Promise.all(providers.map((p) => p.close()));
});

describeDb("external sign-up policy", () => {
  it("refuses a new external account even when the request asks for sign-up", async () => {
    const idp = await newProvider();
    useProvider(idp);
    const res = await oidcLogin(idp, { sub: "s-1", email: "stranger@example.com", email_verified: true }, { requestSignUp: true });
    expect(res.session).toBeNull();
    expect(await getDb().user.count({ where: { email: "stranger@example.com" } })).toBe(0);
  });

  it("allows a verified email from a self-signup domain, never an unverified one", async () => {
    await getDb().instanceSetting.update({ where: { id: 1 }, data: { selfSignupDomains: ["example.org"] } });
    const idp = await newProvider();
    useProvider(idp);
    const unverified = await oidcLogin(idp, { sub: "s-2", email: "maybe@example.org", email_verified: false }, { requestSignUp: true });
    expect(unverified.session).toBeNull();
    const ok = await oidcLogin(idp, { sub: "s-3", email: "Colleague@Example.org", email_verified: true }, { requestSignUp: true });
    expect(ok.session?.user.email).toBe("colleague@example.org");
    const otherDomain = await oidcLogin(idp, { sub: "s-4", email: "x@example.net", email_verified: true }, { requestSignUp: true });
    expect(otherDomain.session).toBeNull();
  });

  it("lets an invited, verified email sign up with OIDC and accept the invite", async () => {
    const { workspace, users } = await workspaceWithRoles();
    const { token } = await createInvite({ workspaceId: workspace.id, email: "invitee@example.com", role: "EDITOR", actorId: users.ADMIN.id });
    const idp = await newProvider();
    useProvider(idp);

    const unverified = await oidcLogin(idp, { sub: "s-5", email: "invitee@example.com", email_verified: false }, { requestSignUp: true });
    expect(unverified.session).toBeNull();

    const login = await oidcLogin(idp, { sub: "s-6", email: "invitee@example.com", email_verified: true, name: "Invitee" }, { requestSignUp: true });
    expect(login.session?.user.email).toBe("invitee@example.com");
    const res = await callRoute(inviteRoute.POST, { method: "POST", body: { intent: "accept", token }, headers: new Headers({ cookie: login.cookie }) });
    expect(res.status).toBe(200);
    const member = await getDb().membership.findFirst({ where: { workspaceId: workspace.id, user: { email: "invitee@example.com" } } });
    expect(member?.role).toBe("EDITOR");
  });

  it("does not accept an expired invite as a reason to create an account", async () => {
    const { workspace: ws, users } = await workspaceWithRoles();
    const admin = users.ADMIN;
    const { id } = await createInvite({ workspaceId: ws.id, email: "late@example.com", role: "VIEWER", actorId: admin.id });
    await getDb().invite.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const idp = await newProvider();
    useProvider(idp);
    const res = await oidcLogin(idp, { sub: "s-7", email: "late@example.com", email_verified: true }, { requestSignUp: true });
    expect(res.session).toBeNull();
  });
});

describeDb("login page external buttons", () => {
  it("create an account for a verified email on an allowed domain", async () => {
    await getDb().instanceSetting.update({ where: { id: 1 }, data: { selfSignupDomains: ["example.org"] } });
    const idp = await newProvider();
    useProvider(idp);
    const res = await oidcLogin(idp, { sub: "l-1", email: "new@example.org", email_verified: true }, LOGIN_PAGE_EXTERNAL_SIGN_IN);
    expect(res.session?.user.email).toBe("new@example.org");
  });

  it("send everyone else back to the login page with a sign-up error", async () => {
    const idp = await newProvider();
    useProvider(idp);
    const res = await oidcLogin(idp, { sub: "l-2", email: "nobody@example.net", email_verified: true }, LOGIN_PAGE_EXTERNAL_SIGN_IN);
    expect(res.session).toBeNull();
    expect(await getDb().user.count()).toBe(0);
    const location = new URL(res.location, BASE);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("signup_not_allowed");
  });
});

describeDb("OIDC identity is issuer + subject", () => {
  it("a different issuer with the same subject does not sign in to the old account", async () => {
    await getDb().instanceSetting.update({ where: { id: 1 }, data: { selfSignupDomains: ["example.com"] } });
    const first = await newProvider();
    useProvider(first);
    const original = await oidcLogin(first, { sub: "same-sub", email: "owner@example.com", email_verified: true }, { requestSignUp: true });
    expect(original.session).not.toBeNull();
    expect((await oidcLogin(first, { sub: "same-sub", email: "owner@example.com", email_verified: true })).session?.user.id).toBe(original.session!.user.id);

    const second = await newProvider();
    useProvider(second);
    const other = await oidcLogin(second, { sub: "same-sub", email: "someone-else@example.com", email_verified: true });
    expect(other.session?.user.id ?? null).not.toBe(original.session!.user.id);
  });

  it("refuses tokens whose issuer is not the configured one", async () => {
    await getDb().instanceSetting.update({ where: { id: 1 }, data: { selfSignupDomains: ["example.com"] } });
    const idp = await newProvider("https://elsewhere.example.com");
    useProvider(idp);
    const res = await oidcLogin(idp, { sub: "s-8", email: "who@example.com", email_verified: true }, { requestSignUp: true });
    expect(res.session).toBeNull();
  });
});

describeDb("sign-in client", () => {
  it("the OIDC button's client call reaches a real Better Auth endpoint", async () => {
    const idp = await newProvider();
    useProvider(idp);
    const client = makeAuthClient({
      baseURL: BASE,
      fetchOptions: {
        customFetchImpl: (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          request.headers.set("origin", BASE);
          return getAuth().handler(request);
        },
      },
    });
    const { data, error } = await startExternalSignIn(providerId(), { callbackURL: "/", disableRedirect: true }, client);
    expect(error, JSON.stringify(error)).toBeNull();
    expect(new URL(data!.url!).origin).toBe(idp.url);
  });
});
