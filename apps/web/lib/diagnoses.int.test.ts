// Stage 6 contract sections 8–9: diagnoses are stored apart from the step errors, saved and read with `run.read`.
import { beforeEach, expect, it } from "vitest";
import * as diagnosesRoute from "../app/api/w/[slug]/runs/[id]/diagnoses/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, sessionHeaders, workspaceWithRoles } from "../test/helpers";
import { getDb } from "./db";

describeDb("run diagnoses", () => {
  let ctx: Awaited<ReturnType<typeof workspaceWithRoles>>;
  let runId: string;
  beforeEach(async () => {
    await resetDatabase();
    ctx = await workspaceWithRoles();
    const db = getDb();
    const site = await db.site.create({ data: { workspaceId: ctx.workspace.id, name: "site" } });
    const env = await db.environment.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Staging", baseUrl: "https://staging.example.com" } });
    const steps = [{ id: "s1", action: "click", selector: "#buy" }];
    const scenario = await db.scenario.create({ data: { workspaceId: ctx.workspace.id, siteId: site.id, name: "Checkout", steps } });
    const run = await db.run.create({
      data: {
        workspaceId: ctx.workspace.id,
        scenarioId: scenario.id,
        environmentId: env.id,
        trigger: "manual",
        status: "failed",
        snapshot: { scenario: { id: scenario.id, name: "Checkout", stepFormatVersion: 1, steps }, environment: { id: env.id, name: env.name, baseUrl: env.baseUrl }, device: { viewport: { width: 1280, height: 720 } }, attachments: [], variableKeys: [] },
        queuedAt: new Date(),
      },
    });
    await db.stepResult.create({ data: { runId: run.id, index: 0, stepId: "s1", action: "click", status: "failed", attempts: 1, startedAt: new Date(), durationMs: 10, errorMessage: "not found" } });
    runId = run.id;
  });

  const call = async (user: keyof typeof ctx.users, method: "GET" | "POST", body?: unknown, slug = ctx.workspace.slug, id = runId) =>
    callRoute(method === "GET" ? diagnosesRoute.GET : diagnosesRoute.POST, { method, params: { slug, id }, headers: await sessionHeaders(ctx.users[user].id), body });

  it("a viewer saves a diagnosis; it is listed and the step error is untouched", async () => {
    const res = await call("VIEWER", "POST", { provider: "claude", text: "The button moved." });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ provider: "claude", text: "The button moved.", createdBy: { id: ctx.users.VIEWER.id } });
    const list = await (await call("EDITOR", "GET")).json();
    expect(list.diagnoses).toHaveLength(1);
    const step = await getDb().stepResult.findFirstOrThrow({ where: { runId } });
    expect(step.errorMessage).toBe("not found");
  });

  it("refuses bad input, other workspaces and unknown runs", async () => {
    expect((await call("VIEWER", "POST", { provider: "gemini", text: "x" })).status).toBe(400);
    expect((await call("VIEWER", "POST", { provider: "codex", text: "  " })).status).toBe(400);
    expect((await call("VIEWER", "POST", { provider: "codex", text: "x".repeat(20_001) })).status).toBe(400);
    expect((await call("OUTSIDER", "POST", { provider: "codex", text: "x" })).status).toBe(404);
    expect((await call("ADMIN", "GET", undefined, ctx.workspace.slug, "nope")).status).toBe(404);
    expect((await call("OUTSIDER", "GET", undefined, ctx.other.slug)).status).toBe(404);
    expect(await getDb().runDiagnosis.count()).toBe(0);
  });
});
