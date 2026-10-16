// Personal variables in server runs (variables contract section 3): each run uses its requester's own value,
// and a value removed after creation ends the run error(variable_missing) — never someone else's value.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createWorker, type Worker } from "../src/worker.js";
import { describeDb, getDb, resetDatabase, seedRun, testConfig, waitForStatus } from "./helpers.js";

describeDb("personal variables in server runs", () => {
  let server: Server;
  let baseUrl: string;
  let worker: Worker | undefined;

  // Echoes the request path, so a step can assert which value went into the URL.
  beforeAll(async () => {
    server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<h1>${decodeURIComponent(req.url ?? "")}</h1>`));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(resetDatabase);
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
  });

  async function user(name: string) {
    const id = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return getDb().user.create({ data: { id, name, email: `${id}@example.com`, emailVerified: true } });
  }

  it("each requester's run uses their own value; a deleted value ends the run variable_missing", async () => {
    const db = getDb();
    const steps = (expected: string) => [
      { id: "s1", action: "goto" as const, url: "/u/{{ACCOUNT}}" },
      { id: "s2", action: "assertText" as const, selector: "h1", expected },
    ];
    const a = await seedRun({ baseUrl, steps: steps("/u/mina") });
    const runA = await db.run.findUniqueOrThrow({ where: { id: a.runId } });
    const variable = await db.variable.create({ data: { workspaceId: a.workspaceId, environmentId: runA.environmentId!, key: "ACCOUNT", scope: "personal" } });
    const mina = await user("mina");
    const leo = await user("leo");
    const sara = await user("sara");
    await db.personalVariableValue.createMany({ data: [{ variableId: variable.id, userId: mina.id, value: "mina" }, { variableId: variable.id, userId: leo.id, value: "leo" }, { variableId: variable.id, userId: sara.id, value: "sara" }] });
    await db.run.update({ where: { id: a.runId }, data: { requestedById: mina.id } });
    const snapshotB = { ...(runA.snapshot as object), scenario: { ...(runA.snapshot as { scenario: object }).scenario, steps: steps("/u/leo") } };
    const runB = await db.run.create({ data: { workspaceId: a.workspaceId, scenarioId: runA.scenarioId, environmentId: runA.environmentId, trigger: "manual", snapshot: snapshotB, requestedById: leo.id } });
    // Sara's value is removed after her run was created.
    const runC = await db.run.create({ data: { workspaceId: a.workspaceId, scenarioId: runA.scenarioId, environmentId: runA.environmentId, trigger: "manual", snapshot: snapshotB, requestedById: sara.id } });
    await db.personalVariableValue.deleteMany({ where: { userId: sara.id } });

    worker = createWorker(db, await testConfig());
    await worker.start();
    expect(await waitForStatus(a.runId, ["passed", "failed", "error"])).toMatchObject({ status: "passed" });
    expect(await waitForStatus(runB.id, ["passed", "failed", "error"])).toMatchObject({ status: "passed" });
    const c = await waitForStatus(runC.id, ["passed", "failed", "error"]);
    expect(c).toMatchObject({ status: "error", errorCode: "variable_missing" });
    expect(c.errorMessage).toContain("ACCOUNT");
    expect(c.errorMessage).not.toMatch(/mina|leo/);
  });
});
