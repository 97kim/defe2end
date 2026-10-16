// Schedule fires in a running worker (stage 5 contract section 4): the worker's round fires a due schedule
// with the schedule's own value, the group runs to the end, and its finish queues a Slack delivery.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encryptSecret, parseEncryptionKey } from "@defe2end/shared/server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createWorker, type Worker } from "../src/worker.js";
import { describeDb, getDb, resetDatabase, testConfig, waitFor } from "./helpers.js";

describeDb("schedules in the worker", () => {
  let server: Server;
  let baseUrl: string;
  let worker: Worker | undefined;
  const slack: string[] = [];

  // Echoes the request path for the steps; POSTs are the fake Slack.
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === "POST") {
        slack.push(req.url ?? "");
        return res.writeHead(200).end("ok");
      }
      res.writeHead(200, { "content-type": "text/html" }).end(`<h1>${decodeURIComponent(req.url ?? "")}</h1>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(resetDatabase);
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
  });

  it("fires a due schedule with its own value, runs the group to the end and queues the finish message", async () => {
    const db = getDb();
    const workspace = await db.workspace.create({ data: { name: "ws", slug: `ws-${Date.now()}` } });
    const site = await db.site.create({ data: { workspaceId: workspace.id, name: "site" } });
    const environment = await db.environment.create({ data: { workspaceId: workspace.id, siteId: site.id, name: "Local", baseUrl } });
    const scenario = await db.scenario.create({
      data: {
        workspaceId: workspace.id,
        siteId: site.id,
        name: "home",
        steps: [
          { id: "s1", action: "goto", url: "/u/{{ACCOUNT}}" },
          { id: "s2", action: "assertText", selector: "h1", expected: "/u/bot" },
        ],
      },
    });
    const variable = await db.variable.create({ data: { workspaceId: workspace.id, environmentId: environment.id, key: "ACCOUNT", scope: "personal" } });
    const schedule = await db.schedule.create({
      data: { workspaceId: workspace.id, name: "Nightly", environmentId: environment.id, scenarioIds: [scenario.id], cron: "0 3 1 1 *", timezone: "UTC", nextRunAt: new Date(Date.now() - 1_000) },
    });
    await db.scheduleVariableValue.create({ data: { scheduleId: schedule.id, variableId: variable.id, value: "bot" } });
    const key = parseEncryptionKey(process.env.DEFE2END_ENCRYPTION_KEY);
    const hook = await db.slackWebhook.create({ data: { workspaceId: workspace.id, name: "alerts", urlEncrypted: encryptSecret(`${baseUrl}/hook`, key), urlHint: "hook", notifyOn: "all", sources: ["schedule"] } });

    worker = createWorker(db, await testConfig());
    await worker.start();
    const fire = await waitFor(() => db.scheduleFire.findFirst({ where: { scheduleId: schedule.id } }));
    expect(fire).toMatchObject({ status: "started", scheduleVersion: 1 });
    const group = await waitFor(async () => {
      const g = await db.groupRun.findUnique({ where: { id: fire.groupRunId! } });
      return g && ["passed", "failed", "error"].includes(g.status) ? g : null;
    }, 60_000);
    expect(group).toMatchObject({ status: "passed", scheduleId: schedule.id, requestedById: null });
    expect((await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).nextRunAt!.getTime()).toBeGreaterThan(Date.now());

    const delivery = await waitFor(() => db.notificationDelivery.findFirst({ where: { webhookId: hook.id, groupRunId: group.id } }));
    expect(delivery).toMatchObject({ kind: "group", payload: { kind: "group", status: "passed", origin: { kind: "schedule", name: "Nightly" } } });
    await waitFor(async () => (await db.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status === "sent", 20_000);
    expect(slack).toEqual(["/hook"]);
  });
});
