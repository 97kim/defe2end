import { hashLinkToken } from "@defe2end/shared/server";
import { beforeEach, expect, it, vi } from "vitest";
import { describeDb, resetDatabase } from "../../test/db";
import { callRoute, createUser, sessionHeaders, TEST_PASSWORD, workspaceWithRoles } from "../../test/helpers";
import { getAuth } from "../auth";
import { getDb } from "../db";
import * as members from "../../app/api/w/[slug]/members/route";
import * as member from "../../app/api/w/[slug]/members/[id]/route";
import * as invites from "../../app/api/w/[slug]/invites/route";
import * as invite from "../../app/api/w/[slug]/invites/[id]/route";
import * as inviteAccept from "../../app/api/invite/route";
import * as reset from "../../app/api/reset/route";
import * as users from "../../app/api/admin/users/route";
import * as user from "../../app/api/admin/users/[id]/route";
import * as resetLink from "../../app/api/admin/users/[id]/reset-link/route";
import * as sites from "../../app/api/w/[slug]/route";
import { createAdminCommand, resetLinkCommand } from "../../cli/defe2end.mjs";

let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;

beforeEach(async () => {
  await resetDatabase();
  ctx = await workspaceWithRoles();
});

const as = async (userId: string) => sessionHeaders(userId);
const signIn = (email: string, password = TEST_PASSWORD) =>
  getAuth().api.signInEmail({ body: { email, password }, asResponse: true });

async function issueInvite(email: string, role = "EDITOR") {
  const res = await callRoute(invites.POST, { method: "POST", params: { slug: ctx.workspace.slug }, body: { email, role }, headers: await as(ctx.users.ADMIN.id) });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string };
}

const postInvite = (body: object, headers?: Headers) => callRoute(inviteAccept.POST, { method: "POST", body, headers });

describeDb("members", () => {
  it("lists members for every role and hides invites from non-admins", async () => {
    const res = await callRoute(members.GET, { params: { slug: ctx.workspace.slug }, headers: await as(ctx.users.VIEWER.id) });
    expect(res.status).toBe(200);
    expect((await res.json()).members).toHaveLength(3);
    const inv = await callRoute(invites.GET, { params: { slug: ctx.workspace.slug }, headers: await as(ctx.users.EDITOR.id) });
    expect(inv.status).toBe(403);
  });

  it("never demotes or removes the last admin", async () => {
    const adminMembership = await getDb().membership.findFirstOrThrow({ where: { userId: ctx.users.ADMIN.id, workspaceId: ctx.workspace.id } });
    const params = { slug: ctx.workspace.slug, id: adminMembership.id };
    const headers = await as(ctx.users.ADMIN.id);
    const demote = await callRoute(member.PATCH, { method: "PATCH", params, body: { role: "EDITOR" }, headers });
    expect(demote.status).toBe(409);
    expect((await callRoute(member.DELETE, { method: "DELETE", params, headers })).status).toBe(409);

    // With a second admin the first may step down.
    const editor = await getDb().membership.findFirstOrThrow({ where: { userId: ctx.users.EDITOR.id, workspaceId: ctx.workspace.id } });
    expect((await callRoute(member.PATCH, { method: "PATCH", params: { ...params, id: editor.id }, body: { role: "ADMIN" }, headers })).status).toBe(200);
    expect((await callRoute(member.PATCH, { method: "PATCH", params, body: { role: "VIEWER" }, headers })).status).toBe(200);
    expect(await getDb().auditLog.count({ where: { action: "member.role_change" } })).toBe(2);
  });

  it("concurrent demotions of two admins leave one admin", async () => {
    const editor = await getDb().membership.findFirstOrThrow({ where: { userId: ctx.users.EDITOR.id, workspaceId: ctx.workspace.id } });
    await getDb().membership.update({ where: { id: editor.id }, data: { role: "ADMIN" } });
    const all = await getDb().membership.findMany({ where: { workspaceId: ctx.workspace.id, role: "ADMIN" } });
    const headers = await as(ctx.users.ADMIN.id);
    const results = await Promise.all(
      all.map((m) => callRoute(member.PATCH, { method: "PATCH", params: { slug: ctx.workspace.slug, id: m.id }, body: { role: "VIEWER" }, headers })),
    );
    // The loser gets 409 (last admin) or, if the acting admin was demoted first, 403 from the role check.
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect([403, 409]).toContain(statuses.find((s) => s !== 200));
    expect(await getDb().membership.count({ where: { workspaceId: ctx.workspace.id, role: "ADMIN" } })).toBe(1);
  });

  it("a role change takes effect on the next request", async () => {
    const editor = await getDb().membership.findFirstOrThrow({ where: { userId: ctx.users.EDITOR.id, workspaceId: ctx.workspace.id } });
    const editorHeaders = await as(ctx.users.EDITOR.id);
    const write = () => callRoute(invites.POST, { method: "POST", params: { slug: ctx.workspace.slug }, body: { email: "x@example.com", role: "VIEWER" }, headers: editorHeaders });
    await callRoute(member.PATCH, { method: "PATCH", params: { slug: ctx.workspace.slug, id: editor.id }, body: { role: "ADMIN" }, headers: await as(ctx.users.ADMIN.id) });
    expect((await write()).status).toBe(201);
    await callRoute(member.PATCH, { method: "PATCH", params: { slug: ctx.workspace.slug, id: editor.id }, body: { role: "VIEWER" }, headers: await as(ctx.users.ADMIN.id) });
    expect((await write()).status).toBe(403);
    // Same session, now removed: the workspace disappears (404).
    await callRoute(member.DELETE, { method: "DELETE", params: { slug: ctx.workspace.slug, id: editor.id }, headers: await as(ctx.users.ADMIN.id) });
    expect((await callRoute(sites.GET, { params: { slug: ctx.workspace.slug }, headers: editorHeaders })).status).toBe(404);
  });

  it("answers 404 for a membership or invite id from another workspace", async () => {
    const theirs = await getDb().membership.findFirstOrThrow({ where: { workspaceId: ctx.other.id } });
    const headers = await as(ctx.users.ADMIN.id);
    const res = await callRoute(member.PATCH, { method: "PATCH", params: { slug: ctx.workspace.slug, id: theirs.id }, body: { role: "VIEWER" }, headers });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    const otherInvite = await getDb().invite.create({
      data: { workspaceId: ctx.other.id, email: "o@example.com", role: "VIEWER", tokenHash: "h", expiresAt: new Date(Date.now() + 1e6), createdById: ctx.users.OUTSIDER.id },
    });
    expect((await callRoute(invite.DELETE, { method: "DELETE", params: { slug: ctx.workspace.slug, id: otherInvite.id }, headers })).status).toBe(404);
    expect((await getDb().invite.findUniqueOrThrow({ where: { id: otherInvite.id } })).revokedAt).toBeNull();
  });
});

describeDb("invites", () => {
  it("stores only the hash and lets a new user join once", async () => {
    const { id, token } = await issueInvite("New.Person@Example.com", "VIEWER");
    const stored = await getDb().invite.findUniqueOrThrow({ where: { id } });
    expect(stored.tokenHash).toBe(hashLinkToken(token));
    expect(stored.email).toBe("new.person@example.com");

    const info = await (await postInvite({ intent: "inspect", token })).json();
    expect(info).toMatchObject({ state: "valid", email: "new.person@example.com", role: "VIEWER", hasAccount: false });

    const res = await postInvite({ intent: "signup", token, name: "New Person", password: "a long password" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: ctx.workspace.slug });
    const joined = await getDb().user.findUniqueOrThrow({ where: { email: "new.person@example.com" }, include: { memberships: true } });
    expect(joined.memberships).toMatchObject([{ workspaceId: ctx.workspace.id, role: "VIEWER" }]);
    expect((await signIn("new.person@example.com", "a long password")).status).toBe(200);

    const again = await postInvite({ intent: "signup", token, name: "Someone", password: "a long password" });
    expect(again.status).toBe(409);
    expect((await again.json()).error.state).toBe("used");
    expect(await getDb().auditLog.count({ where: { action: "invite.accept" } })).toBe(1);
  });

  it("signed-in user with the invited email (any case) joins; another account is refused", async () => {
    const invitee = await createUser({ email: "member@example.com" });
    const { token } = await issueInvite("MEMBER@example.com");
    const wrong = await postInvite({ intent: "accept", token }, await as(ctx.users.OUTSIDER.id));
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error.state).toBe("wrong_account");
    expect((await postInvite({ intent: "accept", token })).status).toBe(401);

    const ok = await postInvite({ intent: "accept", token }, await as(invitee.id));
    expect(ok.status).toBe(200);
    expect(await getDb().membership.count({ where: { userId: invitee.id, workspaceId: ctx.workspace.id } })).toBe(1);
  });

  it("refuses signup when the email already has an account", async () => {
    await createUser({ email: "exists@example.com" });
    const { token } = await issueInvite("exists@example.com");
    const res = await postInvite({ intent: "signup", token, name: "X", password: "a long password" });
    expect(res.status).toBe(409);
    expect(await getDb().invite.count({ where: { usedAt: { not: null } } })).toBe(0);
  });

  it("rejects expired, revoked, unknown and replaced links", async () => {
    const expired = await issueInvite("late@example.com");
    await getDb().invite.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await postInvite({ intent: "signup", token: expired.token, name: "Late", password: "a long password" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.state).toBe("expired");
    expect(await getDb().user.count({ where: { email: "late@example.com" } })).toBe(0);

    const revoked = await issueInvite("gone@example.com");
    expect((await callRoute(invite.DELETE, { method: "DELETE", params: { slug: ctx.workspace.slug, id: revoked.id }, headers: await as(ctx.users.ADMIN.id) })).status).toBe(204);
    expect((await (await postInvite({ intent: "inspect", token: revoked.token })).json()).state).toBe("revoked");
    expect((await (await postInvite({ intent: "signup", token: revoked.token, name: "G", password: "a long password" })).json()).error.state).toBe("revoked");

    expect((await (await postInvite({ intent: "inspect", token: "not-a-token" })).json()).state).toBe("invalid");
    expect((await postInvite({ intent: "signup", token: "not-a-token", name: "N", password: "a long password" })).status).toBe(404);

    const first = await issueInvite("twice@example.com");
    await issueInvite("twice@example.com");
    expect((await (await postInvite({ intent: "inspect", token: first.token })).json()).state).toBe("revoked");
  });

  it("lets only one of two concurrent acceptances win", async () => {
    const invitee = await createUser({ email: "race@example.com" });
    const { token } = await issueInvite("race@example.com");
    const headers = await as(invitee.id);
    const results = await Promise.all([postInvite({ intent: "accept", token }, headers), postInvite({ intent: "accept", token }, headers)]);
    // The loser gets 409 (last admin) or, if the acting admin was demoted first, 403 from the role check.
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect([403, 409]).toContain(statuses.find((s) => s !== 200));
  });
});

describeDb("reset links and users", () => {
  async function issueReset(userId: string) {
    const admin = await createUser({ isInstanceAdmin: true });
    const res = await callRoute(resetLink.POST, { method: "POST", params: { id: userId }, body: {}, headers: await as(admin.id) });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
  }
  const postReset = (body: object) => callRoute(reset.POST, { method: "POST", body });

  it("sets the password once and revokes every session", async () => {
    const target = ctx.users.EDITOR;
    const oldSessions = [await as(target.id), await as(target.id)];
    const token = await issueReset(target.id);
    expect((await (await postReset({ intent: "inspect", token })).json()).state).toBe("valid");

    const res = await postReset({ intent: "reset", token, password: "brand new password" });
    expect(res.status).toBe(200);
    for (const headers of oldSessions) {
      expect((await callRoute(sites.GET, { params: { slug: ctx.workspace.slug }, headers })).status).toBe(401);
    }
    expect(await getDb().session.count({ where: { userId: target.id } })).toBe(0);
    expect((await signIn(target.email, TEST_PASSWORD)).status).toBe(401);
    expect((await signIn(target.email, "brand new password")).status).toBe(200);

    const again = await postReset({ intent: "reset", token, password: "another password" });
    expect(again.status).toBe(409);
    expect((await again.json()).error.state).toBe("used");
    expect(await getDb().auditLog.count({ where: { action: "user.password_reset", targetId: target.id } })).toBe(1);
  });

  it("rejects an expired link and an older link once a newer one is issued", async () => {
    const token = await issueReset(ctx.users.VIEWER.id);
    await getDb().resetLink.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await postReset({ intent: "reset", token, password: "brand new password" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.state).toBe("expired");

    const older = await issueReset(ctx.users.VIEWER.id);
    await issueReset(ctx.users.VIEWER.id);
    expect((await (await postReset({ intent: "reset", token: older, password: "brand new password" })).json()).error.state).toBe("revoked");
    expect((await signIn(ctx.users.VIEWER.email)).status).toBe(200);
  });

  it("disabled users can't sign in and lose their sessions; the last instance admin stays enabled", async () => {
    const admin = await createUser({ isInstanceAdmin: true });
    const headers = await as(admin.id);
    const victim = ctx.users.VIEWER;
    const victimSession = await as(victim.id);
    const res = await callRoute(user.PATCH, { method: "PATCH", params: { id: victim.id }, body: { disabled: true }, headers });
    expect(res.status).toBe(200);
    expect((await callRoute(sites.GET, { params: { slug: ctx.workspace.slug }, headers: victimSession })).status).toBe(401);
    expect((await signIn(victim.email)).status).not.toBe(200);

    expect((await callRoute(user.PATCH, { method: "PATCH", params: { id: admin.id }, body: { disabled: true }, headers })).status).toBe(409);
    const list = await (await callRoute(users.GET, { headers })).json();
    expect(list.users.find((u: { id: string }) => u.id === victim.id).disabled).toBe(true);

    await callRoute(user.PATCH, { method: "PATCH", params: { id: victim.id }, body: { disabled: false }, headers });
    expect((await signIn(victim.email)).status).toBe(200);
  });
});

describeDb("admin CLI", () => {
  it("reset-link prints a working one-time link", async () => {
    const link = await resetLinkCommand(getDb(), ctx.users.EDITOR.email.toUpperCase());
    const token = new URL(link).hash.replace("#token=", "");
    expect(link).toMatch(/\/reset#token=/);
    expect((await callRoute(reset.POST, { method: "POST", body: { intent: "reset", token, password: "cli password 1" } })).status).toBe(200);
    expect(await getDb().auditLog.count({ where: { action: "user.reset_link.issue", actorId: null } })).toBe(1);
    await expect(resetLinkCommand(getDb(), "nobody@example.com")).rejects.toThrow(/No user/);
  });

  it("create-admin works only while no instance admin exists, and the link sets the first password", async () => {
    const link = await createAdminCommand(getDb(), "Root@example.com");
    const created = await getDb().user.findUniqueOrThrow({ where: { email: "root@example.com" } });
    expect(created.isInstanceAdmin).toBe(true);
    const token = new URL(link).hash.replace("#token=", "");
    expect((await callRoute(reset.POST, { method: "POST", body: { intent: "reset", token, password: "first password" } })).status).toBe(200);
    expect((await signIn("root@example.com", "first password")).status).toBe(200);
    await expect(createAdminCommand(getDb(), "second@example.com")).rejects.toThrow(/already exists/);
  });

  it("main() prints the link on stdout and fails with usage on bad input", async () => {
    const { main } = await import("../../cli/defe2end.mjs");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { createDbClient } = await import("@defe2end/db");
    expect(await main(["admin", "reset-link", "--email", ctx.users.VIEWER.email], createDbClient())).toBe(0);
    expect(String(out.mock.calls[0]?.[0])).toMatch(/^http:\/\/localhost:3000\/reset#token=[\w-]{43}\n$/);
    expect(await main(["admin", "nope"], createDbClient())).toBe(1);
    out.mockRestore();
    err.mockRestore();
  });
});
