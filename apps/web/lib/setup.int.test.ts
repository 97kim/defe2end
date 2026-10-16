import { randomBytes } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, createUser, sessionHeaders } from "../test/helpers";
import { POST as setupRoute } from "../app/api/setup/route";
import { GET as workspaceRoute } from "../app/api/w/[slug]/route";
import { getAuth } from "./auth";
import { getDb } from "./db";
import { checkEncryptionKey, EncryptionKeyMismatch, issueInstallToken } from "./startup";

const KEY = process.env.DEFE2END_ENCRYPTION_KEY!;

describeDb("startup", () => {
  beforeEach(resetDatabase);

  it("records the key check once and refuses a different key", async () => {
    await checkEncryptionKey(getDb(), KEY);
    await checkEncryptionKey(getDb(), KEY);
    await expect(checkEncryptionKey(getDb(), randomBytes(32).toString("base64"))).rejects.toBeInstanceOf(EncryptionKeyMismatch);
  });

  it("issues an install token only while there is no admin, storing only its hash", async () => {
    const token = await issueInstallToken(getDb());
    expect(token).toBeTruthy();
    const setting = await getDb().instanceSetting.findUniqueOrThrow({ where: { id: 1 } });
    expect(setting.installTokenHash).not.toContain(token!);
    await createUser({ isInstanceAdmin: true });
    expect(await issueInstallToken(getDb())).toBeNull();
  });
});

describeDb("setup", () => {
  beforeEach(resetDatabase);

  const input = { name: "First Admin", email: "Admin@Example.com", password: "a long password", workspaceName: "Shop Web" };
  const post = (body: unknown) => callRoute(setupRoute, { method: "POST", path: "/api/setup", body });

  it("creates the first admin and workspace once; the admin can sign in", async () => {
    const token = (await issueInstallToken(getDb()))!;
    const res = await post({ ...input, token });
    expect(res.status).toBe(201);
    const { slug, userId } = await res.json();
    expect(slug).toBe("shop-web");

    const user = await getDb().user.findUniqueOrThrow({ where: { id: userId }, include: { memberships: true } });
    expect(user).toMatchObject({ email: "admin@example.com", isInstanceAdmin: true });
    expect(user.memberships).toMatchObject([{ role: "ADMIN" }]);
    expect((await getDb().instanceSetting.findUniqueOrThrow({ where: { id: 1 } })).installedAt).not.toBeNull();

    // Real email+password sign-in through Better Auth.
    const signIn = await getAuth().api.signInEmail({ body: { email: "admin@example.com", password: input.password }, asResponse: true });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const ws = await callRoute(workspaceRoute, { params: { slug }, headers: new Headers({ cookie }) });
    expect(await ws.json()).toMatchObject({ slug, role: "ADMIN", memberCount: 1 });

    // Setup is closed afterwards, even with the same token.
    expect((await post({ ...input, email: "b@example.com", token })).status).toBe(404);
  });

  it("rejects a wrong token", async () => {
    await issueInstallToken(getDb());
    expect((await post({ ...input, token: "wrong" })).status).toBe(403);
    expect(await getDb().user.count()).toBe(0);
  });

  it("public sign-up is disabled", async () => {
    const res = await getAuth().api.signUpEmail({ body: { email: "x@example.com", password: "a long password", name: "X" }, asResponse: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await getDb().user.count()).toBe(0);
  });

  it("disabled users cannot sign in", async () => {
    const user = await createUser({ email: "off@example.com" });
    await getDb().user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
    const res = await getAuth().api.signInEmail({ body: { email: "off@example.com", password: "correct horse battery" }, asResponse: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await expect(sessionHeaders(user.id)).rejects.toThrow();
  });
});

describeDb("sign-in rate limit", () => {
  beforeEach(resetDatabase);

  it("blocks repeated sign-in attempts from one address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await getAuth().handler(
        new Request("http://localhost:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", origin: "http://localhost:3000" },
          body: JSON.stringify({ email: "nobody@example.com", password: "wrong password" }),
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});
