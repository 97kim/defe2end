import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as testRoute from "../app/api/w/[slug]/notifications/webhooks/[webhookId]/test/route";
import * as deliveriesRoute from "../app/api/w/[slug]/notifications/webhooks/[webhookId]/deliveries/route";
import * as webhookRoute from "../app/api/w/[slug]/notifications/webhooks/[webhookId]/route";
import * as webhooksRoute from "../app/api/w/[slug]/notifications/webhooks/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { getDb } from "./db";
import { decrypt } from "./encryption";

const SECRET_PATH = "/services/T0/B0/xyzSECRETtoken9";

describeDb("Slack webhook API", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  const h: Record<string, Headers> = {};
  let server: Server;
  let base = "";
  let status = 200;
  let hits = 0;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    for (const [who, user] of Object.entries(ctx.users)) h[who] = await sessionHeaders(user.id);
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        hits++;
        res.writeHead(status);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  type Handler = Parameters<typeof callRoute>[0];
  async function call(handler: Handler, opts: { method?: string; params?: Record<string, string>; body?: unknown; as?: string } = {}) {
    const res = await callRoute(handler, { method: opts.method ?? "GET", params: { slug: ctx.workspace.slug, ...opts.params }, body: opts.body, headers: h[opts.as ?? "ADMIN"] });
    const text = res.status === 204 ? "" : await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  }

  const input = () => ({ name: "alerts", url: `${base}${SECRET_PATH}`, notifyOn: "failures", sources: ["schedule"], dailyReport: true, reportTime: "09:00", reportTimezone: "Asia/Seoul" });

  it("only admins write; the URL is encrypted, write-only and shown as its last 4 characters", async () => {
    expect((await call(webhooksRoute.POST, { method: "POST", body: input(), as: "EDITOR" })).status).toBe(403);
    const created = await call(webhooksRoute.POST, { method: "POST", body: input() });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: "alerts", urlHint: "ken9", notifyOn: "failures", sources: ["schedule"], invalidAt: null });
    expect(created.text).not.toContain("SECRET");
    const row = await getDb().slackWebhook.findUniqueOrThrow({ where: { id: created.json.id } });
    expect(row.urlEncrypted).not.toContain("SECRET");
    expect(decrypt(row.urlEncrypted)).toBe(`${base}${SECRET_PATH}`);
    const list = await call(webhooksRoute.GET, { as: "VIEWER" });
    expect(list.status).toBe(200);
    expect(list.text).not.toContain("SECRET");
    expect((await call(webhooksRoute.POST, { method: "POST", body: { ...input(), reportTimezone: "Mars/Base" } })).status).toBe(400);
  });

  it("keeps the URL when the update leaves it empty, and turns an invalid webhook back on", async () => {
    const { json } = await call(webhooksRoute.POST, { method: "POST", body: input() });
    const before = await getDb().slackWebhook.findUniqueOrThrow({ where: { id: json.id } });
    const patched = await call(webhookRoute.PATCH, { method: "PATCH", params: { webhookId: json.id }, body: { url: "", notifyOn: "all" } });
    expect(patched.json).toMatchObject({ notifyOn: "all", urlHint: "ken9" });
    expect((await getDb().slackWebhook.findUniqueOrThrow({ where: { id: json.id } })).urlEncrypted).toBe(before.urlEncrypted);
    await getDb().slackWebhook.update({ where: { id: json.id }, data: { invalidAt: new Date() } });
    expect((await call(webhookRoute.PATCH, { method: "PATCH", params: { webhookId: json.id }, body: { invalid: false } })).json.invalidAt).toBeNull();
  });

  it("test send goes out at once, shows the result and leaves an attempt; 4xx marks the webhook invalid", async () => {
    const { json } = await call(webhooksRoute.POST, { method: "POST", body: input() });
    hits = 0;
    status = 200;
    const ok = await call(testRoute.POST, { method: "POST", params: { webhookId: json.id } });
    expect(ok.json).toMatchObject({ status: "sent", statusCode: 200 });
    status = 410;
    const gone = await call(testRoute.POST, { method: "POST", params: { webhookId: json.id } });
    expect(gone.json).toMatchObject({ status: "dead", statusCode: 410, errorCode: "rejected" });
    expect(hits).toBe(2);
    const history = await call(deliveriesRoute.GET, { params: { webhookId: json.id }, as: "VIEWER" });
    expect(history.json.deliveries).toHaveLength(2);
    expect(history.json.deliveries[0].attemptRows[0]).toMatchObject({ attempt: 1, statusCode: 410, errorCode: "rejected" });
    expect(history.text).not.toContain("SECRET");
    expect((await getDb().slackWebhook.findUniqueOrThrow({ where: { id: json.id } })).invalidAt).not.toBeNull();
    expect((await call(testRoute.POST, { method: "POST", params: { webhookId: json.id }, as: "EDITOR" })).status).toBe(403);
  });

  it("deletes, and other workspaces get 404", async () => {
    const { json } = await call(webhooksRoute.POST, { method: "POST", body: input() });
    const res = await callRoute(webhookRoute.DELETE, { method: "DELETE", params: { slug: ctx.other.slug, webhookId: json.id }, headers: h.OUTSIDER });
    expect(res.status).toBe(404);
    expect((await call(webhookRoute.DELETE, { method: "DELETE", params: { webhookId: json.id } })).status).toBe(204);
  });
});
