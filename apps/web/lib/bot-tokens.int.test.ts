// Stage 5 contract sections 1.1 and 7: admins manage bot tokens on the web; the raw token appears once, secrets
// never come back, and the audit log has neither.
import { dropUnattendedValues } from "@defe2end/db";
import { beforeEach, expect, it } from "vitest";
import * as listRoute from "../app/api/w/[slug]/bot-tokens/route";
import * as tokenRoute from "../app/api/w/[slug]/bot-tokens/[tokenId]/route";
import * as variableRoute from "../app/api/w/[slug]/variables/[variableId]/route";
import * as valueRoute from "../app/api/w/[slug]/bot-tokens/[tokenId]/values/[variableId]/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { hashBotToken, verifyBotToken } from "./api-v1";
import { getDb } from "./db";
import { encrypt } from "./encryption";

describeDb("bot token management", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let admin: Headers;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    admin = await sessionHeaders(ctx.users.ADMIN.id);
  });

  const slug = () => ctx.workspace.slug;

  it("creates with a one-time raw token, lists without it, revokes at once, and audits without secrets", async () => {
    const editor = await sessionHeaders(ctx.users.EDITOR.id);
    const body = { name: "GitHub", scopes: ["runs:create", "runs:read"] };
    expect((await callRoute(listRoute.POST, { method: "POST", headers: editor, params: { slug: slug() }, body })).status).toBe(403);
    expect((await callRoute(listRoute.POST, { method: "POST", headers: admin, params: { slug: slug() }, body: { ...body, expiresInDays: 366 } })).status).toBe(400);

    const res = await callRoute(listRoute.POST, { method: "POST", headers: admin, params: { slug: slug() }, body });
    expect(res.status).toBe(201);
    const { token, item } = await res.json();
    expect(token).toMatch(/^d2e_[A-Za-z0-9_-]{40,}$/);
    expect(item.prefix).toBe(token.slice(0, 8));
    const days = (new Date(item.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
    const row = await getDb().botToken.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.tokenHash).toBe(hashBotToken(token));

    const list = await (await callRoute(listRoute.GET, { headers: await sessionHeaders(ctx.users.VIEWER.id), params: { slug: slug() } })).json();
    expect(JSON.stringify(list)).not.toContain(token);
    expect(JSON.stringify(list)).not.toContain(row.tokenHash);
    expect(list.items[0]).toMatchObject({ name: "GitHub", createdByName: expect.any(String), lastUsedAt: null });

    expect(await verifyBotToken(token)).not.toBeNull();
    expect((await callRoute(tokenRoute.DELETE, { method: "DELETE", headers: admin, params: { slug: slug(), tokenId: item.id } })).status).toBe(204);
    expect(await verifyBotToken(token)).toBeNull();

    const logs = await getDb().auditLog.findMany({ where: { targetId: item.id } });
    expect(logs.map((l) => l.action).sort()).toEqual(["botToken.create", "botToken.revoke"]);
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it("bot values: secrets stored encrypted and shown as hasValue only; another workspace's token is 404", async () => {
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    const env = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://shop.example.com", useAuthSession: true } });
    const secret = await db.variable.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, key: "PASSWORD", scope: "personal", isSecret: true } });
    const { item } = await (await callRoute(listRoute.POST, { method: "POST", headers: admin, params: { slug: slug() }, body: { name: "CI", scopes: ["runs:create"] } })).json();
    const params = { slug: slug(), tokenId: item.id, variableId: secret.id };
    expect((await callRoute(valueRoute.PUT, { method: "PUT", headers: admin, params, body: { value: "hunter2" } })).status).toBe(204);
    const stored = await db.botVariableValue.findFirstOrThrow({ where: { botTokenId: item.id } });
    expect(stored.value).toBeNull();
    expect(stored.valueEncrypted).not.toContain("hunter2");

    const detail = await (await callRoute(tokenRoute.GET, { headers: admin, params: { slug: slug(), tokenId: item.id } })).json();
    expect(detail.values).toEqual([expect.objectContaining({ key: "PASSWORD", hasValue: true, value: null })]);
    expect(detail.sessions).toEqual([expect.objectContaining({ environmentId: env.id, savedAt: null })]);
    expect(JSON.stringify(detail)).not.toContain("hunter2");
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain("hunter2");

    const outsider = await sessionHeaders(ctx.users.OUTSIDER.id);
    const foreign = await (await callRoute(listRoute.POST, { method: "POST", headers: outsider, params: { slug: ctx.other.slug }, body: { name: "x", scopes: ["runs:read"] } })).json();
    expect((await callRoute(tokenRoute.GET, { headers: admin, params: { slug: slug(), tokenId: foreign.item.id } })).status).toBe(404);
    expect((await callRoute(valueRoute.DELETE, { method: "DELETE", headers: admin, params: { ...params, tokenId: foreign.item.id } })).status).toBe(404);
  });

  it("a bot value saved while the variable turns secret is stored encrypted or dropped, never plain", async () => {
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    const env = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://shop.example.com" } });
    const variable = await db.variable.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, key: "PASSWORD", scope: "personal" } });
    const { item } = await (await callRoute(listRoute.POST, { method: "POST", headers: admin, params: { slug: slug() }, body: { name: "CI", scopes: ["runs:create"] } })).json();
    // The secret-flag change as the variable route does it: update the row, drop own values, commit later.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let updated!: () => void;
    const isUpdated = new Promise<void>((r) => (updated = r));
    const change = db.$transaction(async (tx) => {
      await tx.variable.update({ where: { id: variable.id }, data: { isSecret: true } });
      await dropUnattendedValues(tx, variable.id);
      updated();
      await held;
    }, { timeout: 20_000 });
    await isUpdated;
    const save = callRoute(valueRoute.PUT, { method: "PUT", headers: admin, params: { slug: slug(), tokenId: item.id, variableId: variable.id }, body: { value: "plain-text" } });
    await new Promise((r) => setTimeout(r, 200));
    release();
    await change;
    expect((await save).status).toBe(204);
    const stored = await db.botVariableValue.findFirstOrThrow({ where: { botTokenId: item.id } });
    expect(stored.value).toBeNull();
    expect(stored.valueEncrypted).toBeTruthy();
  });

  it("concurrent variable PATCHes decide on the locked definition: values of the secret phase are dropped", async () => {
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    const env = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://shop.example.com" } });
    const variable = await db.variable.create({ data: { workspaceId: ctx.workspace.id, environmentId: env.id, key: "PASSWORD", scope: "personal" } });
    const { item } = await (await callRoute(listRoute.POST, { method: "POST", headers: admin, params: { slug: slug() }, body: { name: "CI", scopes: ["runs:create"] } })).json();
    // First change (held open): turn it secret, and own values are set for the secret definition.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let updated!: () => void;
    const isUpdated = new Promise<void>((r) => (updated = r));
    const first = db.$transaction(async (tx) => {
      await tx.variable.update({ where: { id: variable.id }, data: { isSecret: true } });
      await dropUnattendedValues(tx, variable.id);
      await tx.personalVariableValue.create({ data: { variableId: variable.id, userId: ctx.users.ADMIN.id, valueEncrypted: encrypt("p") } });
      await tx.botVariableValue.create({ data: { botTokenId: item.id, variableId: variable.id, valueEncrypted: encrypt("b") } });
      updated();
      await held;
    }, { timeout: 20_000 });
    await isUpdated;
    // Second change, sent before the first commits: back to non-secret — a secret-flag change that drops values.
    const second = callRoute(variableRoute.PATCH, { method: "PATCH", headers: admin, params: { slug: slug(), variableId: variable.id }, body: { isSecret: false } });
    await new Promise((r) => setTimeout(r, 200));
    release();
    await first;
    expect((await second).status).toBe(200);
    expect(await db.variable.findUniqueOrThrow({ where: { id: variable.id } })).toMatchObject({ isSecret: false });
    expect(await db.personalVariableValue.count({ where: { variableId: variable.id } })).toBe(0);
    expect(await db.botVariableValue.count({ where: { variableId: variable.id } })).toBe(0);
  });
});
