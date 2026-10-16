import { beforeAll, expect, it, vi } from "vitest";
import * as list from "../app/api/w/[slug]/scenarios/route";
import * as one from "../app/api/w/[slug]/scenarios/[id]/route";
import * as archive from "../app/api/w/[slug]/scenarios/[id]/archive/route";
import * as duplicate from "../app/api/w/[slug]/scenarios/[id]/duplicate/route";
import * as scenarioTags from "../app/api/w/[slug]/scenarios/[id]/tags/route";
import * as scenarioTag from "../app/api/w/[slug]/scenarios/[id]/tags/[tagId]/route";
import * as unarchive from "../app/api/w/[slug]/scenarios/[id]/unarchive/route";
import * as exporter from "../app/api/w/[slug]/scenarios/export/route";
import * as importer from "../app/api/w/[slug]/scenarios/import/route";
import * as tags from "../app/api/w/[slug]/tags/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { getDb } from "./db";
import { encrypt } from "./encryption";
import { SCENARIO_TRANSFER_MAX } from "./scenario-helpers";
import { RETRY_SETTING_STORED } from "./scenarios";

const STEPS = [
  { id: "s1", action: "goto", url: "/products/linen-shirt" },
  { id: "s2", action: "fill", selector: 'input[name="cvc"]', value: "{{CARD_CVC}}", timeout: 15000, optional: true },
  { id: "s3", action: "assertText", selector: "h1", expected: "Order complete" },
];

describeDb("scenario API", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let site: { id: string };
  let otherSite: { id: string };
  let editor: Headers;
  let viewer: Headers;
  let outsider: Headers;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    const db = getDb();
    site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    otherSite = await db.site.create({ data: { workspaceId: ctx.other.id, name: "Shop" } });
    const env = await db.environment.create({
      data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://staging.shop.example.com" },
    });
    await db.variable.create({
      data: { workspaceId: ctx.workspace.id, environmentId: env.id, key: "CARD_CVC", isSecret: true, valueEncrypted: encrypt("secret-cvc-987") },
    });
    editor = await sessionHeaders(ctx.users.EDITOR.id);
    viewer = await sessionHeaders(ctx.users.VIEWER.id);
    outsider = await sessionHeaders(ctx.users.OUTSIDER.id);
  });

  const slug = () => ctx.workspace.slug;
  async function create(body: Record<string, unknown>, headers = editor) {
    return callRoute(list.POST, { method: "POST", params: { slug: slug() }, headers, body: { siteId: site.id, ...body } });
  }
  async function createOk(body: Record<string, unknown> = {}) {
    const res = await create({ name: "Checkout", steps: STEPS, ...body });
    expect(res.status).toBe(201);
    return res.json();
  }
  async function patch(id: string, body: Record<string, unknown>, headers = editor) {
    return callRoute(one.PATCH, { method: "PATCH", params: { slug: slug(), id }, headers, body });
  }

  it("creates, reads and lists a scenario with tags", async () => {
    const created = await createOk({ tags: ["smoke", "checkout"] });
    expect(created).toMatchObject({ name: "Checkout", steps: STEPS, stepCount: 3, site: { id: site.id, name: "Shop" } });
    expect(created.tags.map((t: { name: string }) => t.name)).toEqual(["checkout", "smoke"]);

    const read = await callRoute(one.GET, { params: { slug: slug(), id: created.id }, headers: viewer });
    expect(read.status).toBe(200);
    expect((await read.json()).steps).toEqual(STEPS);

    const all = await (await callRoute(list.GET, { params: { slug: slug() }, headers: viewer })).json();
    expect(all.scenarios.map((s: { id: string }) => s.id)).toContain(created.id);
  });

  it("rejects invalid steps and unknown actions with 400", async () => {
    for (const steps of [[{ id: "1", action: "hover" }], [{ id: "1", action: "click", target: "a" }], [{ id: "1", action: "goto" }], [{ id: "1", action: "click" }, { id: "1", action: "wait" }]]) {
      const res = await create({ name: "Bad", steps });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_request");
    }
    expect((await create({ name: "  " })).status).toBe(400);
    const created = await createOk();
    expect((await patch(created.id, { updatedAt: created.updatedAt, steps: [{ id: "1", action: "drag" }] })).status).toBe(400);
  });

  it("stores the whole-run retry setting (default on), or refuses it until the column exists", async () => {
    const created = await createOk();
    expect(created.retryOnFailure).toBe(RETRY_SETTING_STORED ? true : null);
    const res = await patch(created.id, { updatedAt: created.updatedAt, retryOnFailure: false });
    if (!RETRY_SETTING_STORED) return expect(res.status).toBe(400);
    expect(res.status).toBe(200);
    expect((await res.json()).retryOnFailure).toBe(false);
  });

  it("saves with optimistic concurrency: a stale updatedAt answers 409", async () => {
    const created = await createOk();
    const first = await patch(created.id, { updatedAt: created.updatedAt, name: "Checkout v2", steps: STEPS.slice(0, 1) });
    expect(first.status).toBe(200);
    const saved = await first.json();
    expect(saved).toMatchObject({ name: "Checkout v2", stepCount: 1, updatedByName: ctx.users.EDITOR.email.split("@")[0] });
    expect(saved.updatedAt).not.toBe(created.updatedAt);

    const stale = await patch(created.id, { updatedAt: created.updatedAt, name: "Lost update" });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("conflict");
    expect((await getDb().scenario.findUniqueOrThrow({ where: { id: created.id } })).name).toBe("Checkout v2");
  });

  it("answers 404 for scenario, site and tag ids from another workspace", async () => {
    const theirs = await getDb().scenario.create({ data: { workspaceId: ctx.other.id, siteId: otherSite.id, name: "Theirs" } });
    const theirTag = await getDb().tag.create({ data: { workspaceId: ctx.other.id, name: "theirs" } });
    const mine = await createOk();
    const id = theirs.id;
    const p = { slug: slug(), id };
    const expect404 = async (res: Response) => {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    };

    await expect404(await callRoute(one.GET, { params: p, headers: editor }));
    await expect404(await patch(id, { updatedAt: theirs.updatedAt.toISOString(), name: "x" }));
    await expect404(await callRoute(duplicate.POST, { method: "POST", params: p, headers: editor }));
    await expect404(await callRoute(archive.POST, { method: "POST", params: p, headers: editor }));
    await expect404(await callRoute(unarchive.POST, { method: "POST", params: p, headers: editor }));
    await expect404(await callRoute(scenarioTags.POST, { method: "POST", params: p, headers: editor, body: { name: "x" } }));
    await expect404(await callRoute(exporter.POST, { method: "POST", params: { slug: slug() }, headers: editor, body: { ids: [mine.id, id] } }));
    // Site id from another workspace, on create and on update.
    await expect404(await create({ name: "x", siteId: otherSite.id }));
    await expect404(await patch(mine.id, { updatedAt: mine.updatedAt, siteId: otherSite.id }));
    // Tag id from another workspace.
    await expect404(await callRoute(scenarioTags.POST, { method: "POST", params: { slug: slug(), id: mine.id }, headers: editor, body: { tagId: theirTag.id } }));
    await expect404(await callRoute(scenarioTag.DELETE, { method: "DELETE", params: { slug: slug(), id: mine.id, tagId: theirTag.id }, headers: editor }));
    // Their scenario stays untouched; outsiders can't see ours either.
    expect((await getDb().scenario.findUniqueOrThrow({ where: { id } })).archivedAt).toBeNull();
    await expect404(await callRoute(one.GET, { params: { slug: slug(), id: mine.id }, headers: outsider }));
  });

  it("refuses every viewer write with 403", async () => {
    const mine = await createOk();
    const p = { slug: slug(), id: mine.id };
    const calls = [
      create({ name: "x" }, viewer),
      patch(mine.id, { updatedAt: mine.updatedAt, name: "x" }, viewer),
      callRoute(duplicate.POST, { method: "POST", params: p, headers: viewer }),
      callRoute(archive.POST, { method: "POST", params: p, headers: viewer }),
      callRoute(scenarioTags.POST, { method: "POST", params: p, headers: viewer, body: { name: "x" } }),
      callRoute(tags.POST, { method: "POST", params: { slug: slug() }, headers: viewer, body: { name: "x" } }),
      callRoute(exporter.POST, { method: "POST", params: { slug: slug() }, headers: viewer, body: {} }),
      callRoute(importer.POST, { method: "POST", params: { slug: slug() }, headers: viewer, body: {} }),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
    expect((await getDb().scenario.findUniqueOrThrow({ where: { id: mine.id } })).name).toBe("Checkout");
  });

  it("duplicates as 'Copy of …' with steps and tags, archives and unarchives", async () => {
    const source = await createOk({ tags: ["smoke"] });
    const res = await callRoute(duplicate.POST, { method: "POST", params: { slug: slug(), id: source.id }, headers: editor });
    expect(res.status).toBe(201);
    const copy = await res.json();
    expect(copy).toMatchObject({ name: "Copy of Checkout", steps: STEPS, archivedAt: null });
    expect(copy.tags.map((t: { name: string }) => t.name)).toEqual(["smoke"]);
    expect(copy.id).not.toBe(source.id);

    const archived = await (await callRoute(archive.POST, { method: "POST", params: { slug: slug(), id: copy.id }, headers: editor })).json();
    expect(archived.archivedAt).not.toBeNull();
    const blocked = await patch(copy.id, { updatedAt: archived.updatedAt, name: "x" });
    expect(blocked.status).toBe(409);
    const back = await (await callRoute(unarchive.POST, { method: "POST", params: { slug: slug(), id: copy.id }, headers: editor })).json();
    expect(back.archivedAt).toBeNull();
  });

  it("creates tags on the fly, unique per workspace, and assigns/unassigns them", async () => {
    const s = await createOk();
    const p = { slug: slug(), id: s.id };
    const a = await (await callRoute(scenarioTags.POST, { method: "POST", params: p, headers: editor, body: { name: " nightly " } })).json();
    expect(a.tags.map((t: { name: string }) => t.name)).toEqual(["nightly"]);
    const again = await (await callRoute(tags.POST, { method: "POST", params: { slug: slug() }, headers: editor, body: { name: "nightly" } })).json();
    expect(again.id).toBe(a.tags[0].id);
    expect(await getDb().tag.count({ where: { workspaceId: ctx.workspace.id, name: "nightly" } })).toBe(1);
    // Same name in another workspace is a different tag.
    await getDb().tag.create({ data: { workspaceId: ctx.other.id, name: "nightly" } });

    const removed = await (await callRoute(scenarioTag.DELETE, { method: "DELETE", params: { ...p, tagId: again.id }, headers: editor })).json();
    expect(removed.tags).toEqual([]);
    const listed = await (await callRoute(tags.GET, { params: { slug: slug() }, headers: viewer })).json();
    expect(listed.tags.find((t: { name: string }) => t.name === "nightly")).toMatchObject({ scenarioCount: 0 });
  });

  it("exports without ids or secret values and round-trips through import into another workspace", async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    const db = getDb();
    site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    const env = await db.environment.create({
      data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://staging.shop.example.com" },
    });
    await db.variable.create({
      data: { workspaceId: ctx.workspace.id, environmentId: env.id, key: "CARD_CVC", isSecret: true, valueEncrypted: encrypt("secret-cvc-987") },
    });
    editor = await sessionHeaders(ctx.users.EDITOR.id);
    const a = await createOk({ name: "Checkout", description: "Pays with a saved card", tags: ["smoke"] });
    await createOk({ name: "Guest checkout", steps: [] });
    const archived = await createOk({ name: "Old" });
    await callRoute(archive.POST, { method: "POST", params: { slug: slug(), id: archived.id }, headers: editor });

    const res = await callRoute(exporter.POST, { method: "POST", params: { slug: slug() }, headers: editor, body: {} });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="defe2end-scenarios-/);
    const text = await res.text();
    const file = JSON.parse(text);
    expect(file).toMatchObject({ format: "defe2end.scenario", formatVersion: 1, stepFormatVersion: 1 });
    expect(file.scenarios.map((s: { name: string }) => s.name)).toEqual(["Checkout", "Guest checkout"]);
    expect(file.scenarios[0]).toEqual({ name: "Checkout", description: "Pays with a saved card", site: "Shop", tags: ["smoke"], steps: STEPS });

    // No database ids and no secret values anywhere in the file.
    const ids = [
      ...(await db.scenario.findMany({ select: { id: true } })).map((r) => r.id),
      ...(await db.tag.findMany({ select: { id: true } })).map((r) => r.id),
      ...(await db.site.findMany({ select: { id: true } })).map((r) => r.id),
      ...(await db.environment.findMany({ select: { id: true } })).map((r) => r.id),
      ...(await db.user.findMany({ select: { id: true } })).map((r) => r.id),
      ctx.workspace.id,
    ];
    for (const id of ids) expect(text).not.toContain(id);
    expect(text).not.toContain("secret-cvc-987");
    expect(text).not.toMatch(/"(id|siteId|workspaceId|tagId)"\s*:\s*"c/);

    // Selected export.
    const one1 = await (await callRoute(exporter.POST, { method: "POST", params: { slug: slug() }, headers: editor, body: { ids: [a.id] } })).json();
    expect(one1.scenarios).toHaveLength(1);

    // Import into the other workspace: the site must exist there by name.
    const importer2 = ctx.users.OUTSIDER; // admin of ctx.other
    const h2 = await sessionHeaders(importer2.id);
    const otherSlug = ctx.other.slug;
    const run = (body: unknown) => callRoute(importer.POST, { method: "POST", params: { slug: otherSlug }, headers: h2, body });

    const missing = await (await run({ file, dryRun: true })).json();
    expect(missing.created).toEqual([]);
    expect(missing.skipped.map((s: { reason: string; detail: string }) => [s.reason, s.detail])).toEqual([
      ["site_not_found", "Shop"],
      ["site_not_found", "Shop"],
    ]);
    expect(await db.site.count({ where: { workspaceId: ctx.other.id } })).toBe(0);

    await db.site.create({ data: { workspaceId: ctx.other.id, name: "Shop" } });
    const withBad = { ...file, scenarios: [...file.scenarios, { name: "Broken", site: "Shop", steps: [{ id: "1", action: "hover" }] }] };
    const preview = await (await run({ file: withBad, dryRun: true })).json();
    expect(preview).toMatchObject({ dryRun: true, total: 3 });
    expect(preview.created.map((c: { name: string }) => c.name)).toEqual(["Checkout", "Guest checkout"]);
    expect(preview.skipped).toMatchObject([{ index: 2, name: "Broken", reason: "invalid" }]);
    expect(await db.scenario.count({ where: { workspaceId: ctx.other.id } })).toBe(0);

    const done = await run({ file: withBad });
    expect(done.status).toBe(201);
    expect((await done.json()).created).toHaveLength(2);

    const back = await (await callRoute(exporter.POST, { method: "POST", params: { slug: otherSlug }, headers: h2, body: {} })).json();
    expect(back.scenarios).toEqual(file.scenarios);

    // Bad header → 400, nothing written.
    const bad = await run({ file: { ...file, formatVersion: 2 } });
    expect(bad.status).toBe(400);
  });

  it("rejects whitespace-only names on create, update and import alike", async () => {
    expect((await create({ name: "   " })).status).toBe(400);
    const ok = await createOk({ name: "  Trimmed  " });
    expect(ok.name).toBe("Trimmed");
    expect((await patch(ok.id, { updatedAt: ok.updatedAt, name: " \t " })).status).toBe(400);
    const file = { format: "defe2end.scenario", formatVersion: 1, stepFormatVersion: 1, scenarios: [{ name: "   ", site: "Shop", steps: [] }] };
    const res = await callRoute(importer.POST, { method: "POST", params: { slug: slug() }, headers: editor, body: { file } });
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toMatchObject([{ index: 0, reason: "invalid" }]);
  });

  it("export and import share one cap: 1,000 round-trips, 1,001 is refused with 400 both ways", async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    site = await getDb().site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    editor = await sessionHeaders(ctx.users.EDITOR.id);
    const rows = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => ({ workspaceId: ctx.workspace.id, siteId: site.id, name: `S${from + i}`, steps: [] }));
    await getDb().scenario.createMany({ data: rows(SCENARIO_TRANSFER_MAX) });

    const exp = (body: unknown) => callRoute(exporter.POST, { method: "POST", params: { slug: slug() }, headers: editor, body });
    const imp = (file: unknown) => callRoute(importer.POST, { method: "POST", params: { slug: slug() }, headers: editor, body: { file, dryRun: true } });

    const full = await exp({});
    expect(full.status).toBe(200);
    const file = await full.json();
    expect(file.scenarios).toHaveLength(SCENARIO_TRANSFER_MAX);
    const preview = await imp(file);
    expect(preview.status).toBe(200);
    expect((await preview.json()).created).toHaveLength(SCENARIO_TRANSFER_MAX);

    // Race: a scenario created while the export runs (just before its query) must still hit the cap.
    const db = getDb();
    const realFindMany = db.scenario.findMany.bind(db.scenario);
    const spy = vi.spyOn(db.scenario, "findMany").mockImplementationOnce((async (args: Parameters<typeof realFindMany>[0]) => {
      await db.scenario.createMany({ data: rows(1, SCENARIO_TRANSFER_MAX) });
      return realFindMany(args);
    }) as never);
    const raced = await exp({});
    spy.mockRestore();
    expect(raced.status).toBe(400);
    expect(await db.scenario.count({ where: { workspaceId: ctx.workspace.id } })).toBe(SCENARIO_TRANSFER_MAX + 1);

    const tooMany = await exp({});
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error.message).toContain(String(SCENARIO_TRANSFER_MAX));
    const ids = (await getDb().scenario.findMany({ select: { id: true } })).map((r) => r.id);
    expect((await exp({ ids })).status).toBe(400);
    expect((await imp({ ...file, scenarios: [...file.scenarios, file.scenarios[0]] })).status).toBe(400);
  });
});
