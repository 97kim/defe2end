// Variables contract section 6 (web side): personal values at run creation, the shared resolution used by the
// desktop run message, scope/secret changes, permissions, and that nobody sees anyone else's value.
import { DESKTOP_CAPABILITIES, formatDesktopClientHeader } from "@defe2end/shared";
import { beforeEach, expect, it } from "vitest";
import * as tokenRoute from "../app/api/desktop/token/route";
import * as envVariablesRoute from "../app/api/w/[slug]/environments/[environmentId]/variables/route";
import * as runsRoute from "../app/api/w/[slug]/runs/route";
import * as testRunRoute from "../app/api/w/[slug]/runs/test/route";
import * as mineRoute from "../app/api/w/[slug]/variables/[variableId]/mine/route";
import * as variableRoute from "../app/api/w/[slug]/variables/[variableId]/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { getDb } from "./db";
import { openDesktopStream } from "./desktop/stream";

const MINE_SECRET = "mina-s3cret-value";
const THEIRS_SECRET = "leo-s3cret-value";

describeDb("personal variables", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let editor: Headers;
  let admin: Headers;
  let environment: { id: string };
  let scenario: { id: string };

  beforeEach(async () => {
    await resetDatabase();
    process.env.MIN_FREE_DISK_MB = "0";
    ctx = await workspaceWithRoles();
    editor = await sessionHeaders(ctx.users.EDITOR.id);
    admin = await sessionHeaders(ctx.users.ADMIN.id);
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    environment = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://shop.example.com" } });
    scenario = await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Login", steps: [{ id: "s1", action: "fill", selector: "#pw", value: "{{PASSWORD}}" }] } });
  });

  const slug = () => ctx.workspace.slug;
  const createVariable = async (body: Record<string, unknown>, headers = admin) =>
    (await callRoute(envVariablesRoute.POST, { method: "POST", params: { slug: slug(), environmentId: environment.id }, headers, body })).json();
  const setMine = (variableId: string, value: string, headers = editor) => callRoute(mineRoute.PUT, { method: "PUT", params: { slug: slug(), variableId }, headers, body: { value } });
  const run = (headers = editor, body: Record<string, unknown> = {}) =>
    callRoute(runsRoute.POST, { method: "POST", params: { slug: slug() }, headers, body: { scenarioId: scenario.id, environmentId: environment.id, ...body } });
  const list = async (headers: Headers) => (await (await callRoute(envVariablesRoute.GET, { params: { slug: slug(), environmentId: environment.id }, headers })).json()).variables;

  it("creation needs the requester's own value: none, or only someone else's → 409 variable_missing { keys }", async () => {
    const v = await createVariable({ key: "PASSWORD", scope: "personal", isSecret: true });
    let res = await run();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "variable_missing", keys: ["PASSWORD"] });
    expect((await setMine(v.id, THEIRS_SECRET, admin)).status).toBe(200);
    res = await run();
    const body = await res.json();
    expect(body.error.code).toBe("variable_missing");
    expect(JSON.stringify(body)).not.toContain(THEIRS_SECRET);
    // Test runs go through the same check.
    const test = await callRoute(testRunRoute.POST, { method: "POST", params: { slug: slug() }, headers: editor, body: { environmentId: environment.id, steps: [{ id: "a", action: "goto", url: "/{{PASSWORD}}" }] } });
    expect((await test.json()).error.code).toBe("variable_missing");
    expect((await setMine(v.id, MINE_SECRET)).status).toBe(200);
    expect((await run()).status).toBe(201);
  });

  it("a shared value doesn't stand in once the variable turned personal", async () => {
    const v = await createVariable({ key: "PASSWORD", value: "shared-pw" });
    expect((await run()).status).toBe(201);
    const patched = await callRoute(variableRoute.PATCH, { method: "PATCH", params: { slug: slug(), variableId: v.id }, headers: admin, body: { scope: "personal" } });
    expect(await patched.json()).toMatchObject({ scope: "personal", value: null, mine: { hasValue: false } });
    expect(await getDb().variable.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ value: null, valueEncrypted: null });
    expect((await (await run()).json()).error.code).toBe("variable_missing");
  });

  it("scope and secret changes drop values; the list shows only my own value", async () => {
    const v = await createVariable({ key: "PASSWORD", scope: "personal" });
    await setMine(v.id, "mina-plain");
    await setMine(v.id, "leo-plain", admin);
    const mineView = (await list(editor)).find((x: { id: string }) => x.id === v.id);
    expect(mineView).toMatchObject({ scope: "personal", mine: { hasValue: true, value: "mina-plain" } });
    const listed = JSON.stringify(await list(editor));
    expect(listed).not.toContain("leo-plain");
    // A viewer without a value sees no trace of others' values.
    expect((await list(await sessionHeaders(ctx.users.VIEWER.id))).find((x: { id: string }) => x.id === v.id)).toMatchObject({ mine: { hasValue: false } });

    await callRoute(variableRoute.PATCH, { method: "PATCH", params: { slug: slug(), variableId: v.id }, headers: admin, body: { isSecret: true } });
    expect(await getDb().personalVariableValue.count({ where: { variableId: v.id } })).toBe(0);
    await setMine(v.id, MINE_SECRET);
    expect(JSON.stringify(await list(editor))).not.toContain(MINE_SECRET);
    const row = await getDb().personalVariableValue.findFirstOrThrow({ where: { variableId: v.id } });
    expect(row).toMatchObject({ value: null });
    expect(row.valueEncrypted).not.toContain(MINE_SECRET);
    await callRoute(variableRoute.PATCH, { method: "PATCH", params: { slug: slug(), variableId: v.id }, headers: admin, body: { scope: "shared", value: "now-shared" } });
    expect(await getDb().personalVariableValue.count({ where: { variableId: v.id } })).toBe(0);
    const audits = JSON.stringify(await getDb().auditLog.findMany());
    for (const secret of [MINE_SECRET, "mina-plain", "leo-plain", "now-shared"]) expect(audits).not.toContain(secret);
  });

  it("permissions: viewer 403, shared variable 409, another workspace 404; user deletion drops their values", async () => {
    const personal = await createVariable({ key: "PASSWORD", scope: "personal" });
    const shared = await createVariable({ key: "BASE", value: "x" });
    expect((await setMine(personal.id, "v", await sessionHeaders(ctx.users.VIEWER.id))).status).toBe(403);
    expect((await setMine(shared.id, "v")).status).toBe(409);
    const otherSite = await getDb().site.create({ data: { workspaceId: ctx.other.id, name: "X" } });
    const otherEnv = await getDb().environment.create({ data: { workspaceId: ctx.other.id, siteId: otherSite.id, name: "X", baseUrl: "https://x.example" } });
    const theirs = await getDb().variable.create({ data: { workspaceId: ctx.other.id, environmentId: otherEnv.id, key: "K", scope: "personal" } });
    expect((await setMine(theirs.id, "v")).status).toBe(404);
    expect((await setMine(personal.id, "mine")).status).toBe(200);
    expect((await callRoute(mineRoute.DELETE, { method: "DELETE", params: { slug: slug(), variableId: personal.id }, headers: editor })).status).toBe(204);
    await setMine(personal.id, "mine");
    await getDb().user.delete({ where: { id: ctx.users.EDITOR.id } });
    expect(await getDb().personalVariableValue.count()).toBe(0);
  });

  it("the desktop run message carries the requester's own value; a value deleted before dispatch ends the run variable_missing", async () => {
    const v = await createVariable({ key: "PASSWORD", scope: "personal", isSecret: true });
    await setMine(v.id, MINE_SECRET);
    await setMine(v.id, THEIRS_SECRET, admin);
    const h = new Headers(editor);
    h.set("origin", new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000").origin);
    const { token } = await (await callRoute(tokenRoute.POST, { method: "POST", headers: h, body: { installId: "8b0f5f7e-2a4c-4c1e-9d55-0a4c5c7a1b99", label: "pc" } })).json();
    const opened = await openDesktopStream(
      new Request("http://localhost/api/desktop/stream", {
        headers: { authorization: `Bearer ${token}`, "defe2end-client": formatDesktopClientHeader({ app: "1.0.0", runner: "1.0.0", protocol: 1 }), "defe2end-capabilities": DESKTOP_CAPABILITIES.join(",") },
      }),
    );
    if (!opened.ok) throw new Error("stream refused");
    const first = await (await run(editor, { location: "desktop" })).json();
    const [message] = await opened.session.tick();
    expect(message).toMatchObject({ type: "run", runId: first.id, plan: { variables: { PASSWORD: { value: MINE_SECRET, secret: true } } } });

    const second = await (await run(editor, { location: "desktop" })).json();
    await callRoute(mineRoute.DELETE, { method: "DELETE", params: { slug: slug(), variableId: v.id }, headers: editor });
    expect(await opened.session.tick()).toEqual([]);
    const ended = await getDb().run.findUniqueOrThrow({ where: { id: second.id } });
    expect(ended).toMatchObject({ status: "error", errorCode: "variable_missing" });
    expect(ended.errorMessage).toContain("PASSWORD");
    expect(ended.errorMessage).not.toContain(THEIRS_SECRET);
  });
});
