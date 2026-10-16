// Stage 7 contract sections 4 and 8, the desktop app's side of visual regression: pins in the run, baseline
// download checks, first baseline from an app report, app verdict checks, the warning count, old apps refused,
// pins kept through approvals, and comparison children.
import { approveBaseline } from "@defe2end/db";
import { DESKTOP_CAPABILITIES, DESKTOP_HEADERS, formatDesktopClientHeader, runSnapshotSchema, type RenderConditions } from "@defe2end/shared";
import { encodePng } from "@defe2end/shared/server";
import { beforeEach, expect, it } from "vitest";
import * as artifactRoute from "../../app/api/desktop/runs/[id]/artifacts/[kind]/[attempt]/[key]/route";
import * as baselineRoute from "../../app/api/desktop/runs/[id]/baselines/[versionId]/route";
import * as completeRoute from "../../app/api/desktop/runs/[id]/complete/route";
import * as startRoute from "../../app/api/desktop/runs/[id]/start/route";
import * as tokenRoute from "../../app/api/desktop/token/route";
import * as approveRoute from "../../app/api/w/[slug]/runs/[id]/steps/[stepResultId]/approve-baseline/route";
import * as runsRoute from "../../app/api/w/[slug]/runs/route";
import { describeDb, resetDatabase } from "../../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../../test/helpers";
import { getDb } from "../db";
import { buildRunMessage } from "./run-message";
import { baselineFiles } from "../visual-compare";
import { openDesktopStream, type DesktopStreamSession } from "./stream";

const ORIGIN = new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000").origin;
const RENDER: RenderConditions = { browserVersion: "140.0", deviceScaleFactor: 2, viewport: { width: 1280, height: 720 }, fontSet: "desktop-mac/darwin-25", maskingPolicyVersion: 1 };
const png = (shade: number) => encodePng({ width: 40, height: 30, data: new Uint8Array(40 * 30 * 4).fill(shade).map((v, i) => (i % 4 === 3 ? 255 : v)) });

describeDb("desktop visual regression", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let editor: Headers;
  let environment: { id: string; siteId: string };
  let scenario: { id: string };
  let token: string;
  let session: DesktopStreamSession;

  beforeEach(async () => {
    await resetDatabase();
    process.env.MIN_FREE_DISK_MB = "0";
    ctx = await workspaceWithRoles();
    editor = await sessionHeaders(ctx.users.EDITOR.id);
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "Shop" } });
    environment = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://shop.example.com" } });
    scenario = await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "a", steps: [{ id: "go", action: "goto", url: "/" }, { id: "shot", action: "screenshot" }] } });
    token = (await tokenFor(editor, "8b0f5f7e-2a4c-4c1e-9d55-0a4c5c7a1b12")).token;
    session = await connect(token);
  });

  async function tokenFor(headers: Headers, installId: string) {
    const h = new Headers(headers);
    h.set("origin", ORIGIN);
    return (await (await callRoute(tokenRoute.POST, { method: "POST", headers: h, body: { installId, label: "ab12" } })).json()) as { token: string; deviceId: string };
  }
  async function connect(t: string, capabilities: readonly string[] = DESKTOP_CAPABILITIES) {
    const opened = await openDesktopStream(
      new Request("http://localhost:3000/api/desktop/stream", {
        headers: { authorization: `Bearer ${t}`, "defe2end-client": formatDesktopClientHeader({ app: "1.0.0", runner: "1.0.0", protocol: 1 }), "defe2end-capabilities": capabilities.join(","), "defe2end-active-runs": "" },
      }),
    );
    if (!opened.ok) throw new Error(`refused ${opened.response.status}`);
    return opened.session;
  }
  const app = (t = token, extra: Record<string, string> = {}) => new Headers({ authorization: `Bearer ${t}`, ...extra });
  const createRun = async () => {
    const res = await callRoute(runsRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug }, headers: editor, body: { scenarioId: scenario.id, environmentId: environment.id, location: "desktop" } });
    return { res, id: res.status === 201 ? ((await res.json()) as { id: string }).id : "" };
  };
  const start = async () => {
    const { id } = await createRun();
    await session.tick();
    const started = (await (await callRoute(startRoute.POST, { method: "POST", params: { id }, headers: app() })).json()) as { claimToken: string };
    return { id, claimToken: started.claimToken };
  };
  const upload = (id: string, claimToken: string, body: Uint8Array) =>
    artifactRoute.PUT(new Request("http://localhost/x", { method: "PUT", headers: app(token, { [DESKTOP_HEADERS.claimToken]: claimToken, "content-length": String(body.byteLength) }), body, duplex: "half" } as RequestInit), {
      params: Promise.resolve({ id, kind: "screenshot", attempt: "1", key: "step-1" }),
    });
  const step = (index: number, extra: Record<string, unknown> = {}) => ({ index, stepId: index === 0 ? "go" : "shot", action: index === 0 ? "goto" : "screenshot", status: "passed", attempt: 1, attempts: 1, startedAt: new Date().toISOString(), durationMs: 1, ...extra });
  const complete = (id: string, claimToken: string, shot: Record<string, unknown>) =>
    callRoute(completeRoute.POST, { method: "POST", params: { id }, headers: app(), body: { claimToken, verdict: "passed", stopCause: { type: "none" }, attemptCount: 1, passedAfterRetry: false, durationMs: 1, steps: [step(0), step(1, shot)] } });
  const download = (id: string, versionId: string, t = token) => callRoute(baselineRoute.GET, { params: { id, versionId }, headers: app(t) });

  /** A first run whose app reports `created`: makes baseline version 1. */
  async function firstBaseline() {
    const run = await start();
    expect((await upload(run.id, run.claimToken, png(10))).status).toBe(201);
    expect((await complete(run.id, run.claimToken, { visualVerdict: "created", render: RENDER })).status).toBe(200);
    return { run, version: await getDb().visualBaselineVersion.findFirstOrThrow({ include: { baseline: true } }) };
  }

  it("pins both desktop runtimes, makes the first baseline from the app's report, and serves only pinned versions of running runs", async () => {
    const { run: first, version } = await firstBaseline();
    expect(runSnapshotSchema.parse((await getDb().run.findUniqueOrThrow({ where: { id: first.id } })).snapshot).visual).toEqual({
      device: "1280x720",
      baselines: [{ stepId: "shot", runtime: "desktop-mac", versionId: null }, { stepId: "shot", runtime: "desktop-windows", versionId: null }],
    });
    expect(version).toMatchObject({ version: 1, source: "auto", sourceRunId: first.id });
    expect(version.baseline).toMatchObject({ runtime: "desktop-mac", device: "1280x720", stepId: "shot" });
    expect(await getDb().runBaselinePin.count()).toBe(0);

    const second = await start();
    expect(await getDb().runBaselinePin.findMany({ where: { runId: second.id } })).toEqual([{ runId: second.id, versionId: version.id }]);
    const ok = await download(second.id, version.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(png(10));
    // Another version id, another device, a run that ended.
    expect((await download(second.id, "not-pinned")).status).toBe(404);
    const other = (await tokenFor(editor, "11111111-2a4c-4c1e-9d55-0a4c5c7a1b12")).token;
    expect((await download(second.id, version.id, other)).status).toBe(404);
    expect((await complete(second.id, second.claimToken, { visualVerdict: "match", visualDiffPercent: 0, visualBaselineVersionId: version.id, render: RENDER })).status).toBe(200);
    expect((await download(second.id, version.id)).status).toBe(404);
    expect(await getDb().stepResult.findFirstOrThrow({ where: { runId: second.id, stepId: "shot" } })).toMatchObject({ visualVerdict: "match", visualBaselineVersionId: version.id });
  });

  it("a verdict naming a version outside the run's pins becomes skipped, and the warning count is the server's", async () => {
    const { version } = await firstBaseline();
    const run = await start();
    // The pinned version is v1; the app claims a changed verdict against a version id it made up.
    const forged = { status: "warning", errorCode: "warning", errorMessage: "differs", visualVerdict: "changed", visualDiffPercent: 50, visualBaselineVersionId: `${version.id}x`, render: RENDER };
    expect((await complete(run.id, run.claimToken, forged)).status).toBe(200);
    expect(await getDb().stepResult.findFirstOrThrow({ where: { runId: run.id, stepId: "shot" } })).toMatchObject({ status: "passed", visualVerdict: "skipped", visualBaselineVersionId: null });
    expect(await getDb().run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "passed", warningCount: 0 });
  });

  it("a racing first baseline from the app is compared on the server and counted as a warning", async () => {
    const a = await start();
    const b = await start();
    expect((await upload(a.id, a.claimToken, png(10))).status).toBe(201);
    expect((await upload(b.id, b.claimToken, png(200))).status).toBe(201);
    await complete(a.id, a.claimToken, { visualVerdict: "created", render: RENDER });
    // The app reported a pass with no warning; the server finds b differs from the baseline a made.
    expect((await complete(b.id, b.claimToken, { visualVerdict: "created", render: RENDER })).status).toBe(200);
    expect(await getDb().stepResult.findFirstOrThrow({ where: { runId: b.id, stepId: "shot" } })).toMatchObject({ status: "warning", visualVerdict: "created", visualServerVerdict: "changed" });
    expect(await getDb().run.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: "passed", warningCount: 1 });
    expect(await getDb().visualBaselineVersion.count()).toBe(1);
  });

  it("refuses an app without visual-compare-v1 for a screenshot run, even with no baseline yet", async () => {
    session = await connect(token, DESKTOP_CAPABILITIES.filter((c) => c !== "visual-compare-v1"));
    const { res } = await createRun();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "app_update_required", missing: ["visual-compare-v1"] } });
  });

  it("a waiting run keeps its pinned version through several approvals", async () => {
    const { run: first, version } = await firstBaseline();
    const second = await start();
    await complete(second.id, second.claimToken, { visualVerdict: "match", visualDiffPercent: 0, visualBaselineVersionId: version.id, render: RENDER });
    await getDb().artifact.create({ data: { runId: second.id, workspaceId: ctx.workspace.id, kind: "screenshot", stepIndex: 1, name: "s", storageKey: version.storageKey, contentType: "image/png", sizeBytes: 1 } });
    const { id: waiting } = await createRun();
    const pinned = await getDb().runBaselinePin.findMany({ where: { runId: waiting } });
    expect(pinned).toEqual([{ runId: waiting, versionId: version.id }]);
    const approve = async (runId: string, expectedVersion: number, headers = editor) => {
      const shot = await getDb().stepResult.findFirstOrThrow({ where: { runId, stepId: "shot" } });
      return callRoute(approveRoute.POST, { method: "POST", params: { slug: ctx.workspace.slug, id: runId, stepResultId: shot.id }, headers, body: { expectedVersion } });
    };
    expect(await (await approve(second.id, 1)).json()).toMatchObject({ version: 2 });
    expect(await (await approve(first.id, 2)).json()).toMatchObject({ version: 3 });
    expect((await approve(second.id, 2)).status).toBe(409);
    expect(await getDb().runBaselinePin.findMany({ where: { runId: waiting } })).toEqual(pinned);
    expect((await approve(first.id, 3, await sessionHeaders(ctx.users.VIEWER.id))).status).toBe(403);
  });

  it("refuses to approve a comparison child's result (409)", async () => {
    const { run } = await firstBaseline();
    const comparison = await getDb().envComparison.create({
      data: { workspaceId: ctx.workspace.id, scenarioId: scenario.id, siteId: environment.siteId, leftEnvironmentId: environment.id, rightEnvironmentId: environment.id, leftBaseUrl: "https://a.example.com", rightBaseUrl: "https://b.example.com", location: "desktop", conditions: {}, tolerance: 5, createdById: ctx.users.EDITOR.id },
    });
    await getDb().run.update({ where: { id: run.id }, data: { comparisonId: comparison.id, comparisonSide: "left" } });
    const shot = await getDb().stepResult.findFirstOrThrow({ where: { runId: run.id, stepId: "shot" } });
    const result = await approveBaseline(getDb(), baselineFiles(), { workspaceId: ctx.workspace.id, runId: run.id, stepResultId: shot.id, expectedVersion: 1, userId: ctx.users.EDITOR.id });
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it("marks a comparison child in the run message so the app takes the structure snapshot", async () => {
    const { id } = await createRun();
    const comparison = await getDb().envComparison.create({
      data: { workspaceId: ctx.workspace.id, scenarioId: scenario.id, siteId: environment.siteId, leftEnvironmentId: environment.id, rightEnvironmentId: environment.id, leftBaseUrl: "https://a.example.com", rightBaseUrl: "https://b.example.com", location: "desktop", conditions: {}, tolerance: 5, createdById: ctx.users.EDITOR.id },
    });
    await getDb().run.update({ where: { id }, data: { comparisonId: comparison.id, comparisonSide: "right" } });
    const child = await buildRunMessage((await getDb().run.findUniqueOrThrow({ where: { id } })) as never);
    expect(child.comparison).toEqual({ comparisonId: comparison.id, side: "right" });
    expect(child.baselines).toBeUndefined();
    const { id: plain } = await createRun();
    expect((await buildRunMessage((await getDb().run.findUniqueOrThrow({ where: { id: plain } })) as never)).comparison).toBeUndefined();
  });
});
