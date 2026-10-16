// Scenario list and detail page data: another workspace's id is a 404 (null), the mini history keeps the
// latest 10 runs per scenario and leaves test runs out.
import { beforeEach, expect, it } from "vitest";
process.env.MIN_FREE_DISK_MB = "0";
import { describeDb, resetDatabase } from "../test/db";
import * as testRunRoute from "../app/api/w/[slug]/runs/test/route";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { getDb } from "./db";
import { RECENT_RUNS, scenarioDetailData, scenarioListData } from "./scenario-pages";

describeDb("scenario pages", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  beforeEach(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
  });

  async function scenarioIn(workspaceId: string, name: string, description = "") {
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId, name: `site ${name}` } });
    return db.scenario.create({ data: { workspaceId, siteId: site.id, name, description, steps: [] } });
  }

  it("detail: this workspace's scenario only", async () => {
    const mine = await scenarioIn(ctx.workspace.id, "Checkout");
    const theirs = await scenarioIn(ctx.other.id, "Theirs");
    expect((await scenarioDetailData(ctx.workspace, mine.id))?.scenario.name).toBe("Checkout");
    expect(await scenarioDetailData(ctx.workspace, theirs.id)).toBeNull();
    expect(await scenarioDetailData(ctx.workspace, "missing")).toBeNull();
  });

  it("list: first description line, latest 10 runs oldest first, test runs left out", async () => {
    const s = await scenarioIn(ctx.workspace.id, "Login", "Signs in with a saved user\nSecond line");
    const db = getDb();
    const t0 = Date.parse("2026-10-13T00:00:00Z");
    for (let i = 0; i < 12; i++) {
      await db.run.create({ data: { workspaceId: ctx.workspace.id, scenarioId: s.id, trigger: "manual", status: i === 11 ? "failed" : "passed", snapshot: {}, queuedAt: new Date(t0 + i * 1000) } });
    }
    await db.run.create({ data: { workspaceId: ctx.workspace.id, scenarioId: null, trigger: "test", status: "passed", snapshot: {}, queuedAt: new Date(t0 + 99_000) } });
    const [row] = await scenarioListData(ctx.workspace);
    expect(row!.summary).toBe("Signs in with a saved user");
    expect(row!.recent).toHaveLength(RECENT_RUNS);
    expect(row!.recent.at(-1)!.status).toBe("failed");
    expect(row!.recent[0]!.queuedAt).toBe(new Date(t0 + 2000).toISOString());
  });

  it("a test run from a scenario's editor is its last test run, but stays out of its history and the list", async () => {
    const s = await scenarioIn(ctx.workspace.id, "Checkout");
    const theirs = await scenarioIn(ctx.other.id, "Theirs");
    const env = await getDb().environment.create({ data: { workspaceId: ctx.workspace.id, siteId: s.siteId, name: "Staging", baseUrl: "https://shop.example.com" } });
    const editor = await sessionHeaders(ctx.users.EDITOR.id);
    const start = (scenarioId: string) =>
      callRoute(testRunRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug }, headers: editor, body: { scenarioId, environmentId: env.id, steps: [{ id: "a", action: "goto", url: "/" }] } });
    expect((await start(theirs.id)).status).toBe(404);
    const first = await (await start(s.id)).json();
    const second = await (await start(s.id)).json();
    const row = await getDb().run.findUniqueOrThrow({ where: { id: second.id } });
    expect(row).toMatchObject({ scenarioId: null, testOfScenarioId: s.id, trigger: "test" });
    const detail = await scenarioDetailData(ctx.workspace, s.id);
    expect(detail!.lastTestRunId).toBe(second.id);
    expect(first.id).not.toBe(second.id);
    expect(detail!.history).toEqual([]);
    expect((await scenarioListData(ctx.workspace)).find((r) => r.id === s.id)!.recent).toEqual([]);
  });
});
