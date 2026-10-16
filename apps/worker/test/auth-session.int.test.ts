// Login sessions in server runs (stage 4 contract section 5): the worker decrypts the requester's own session
// right before the run and puts it into the browser context; without one the run ends auth_session_missing.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encryptSecret, parseEncryptionKey } from "@defe2end/shared/server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createWorker, type Worker } from "../src/worker.js";
import { describeDb, getDb, resetDatabase, seedRun, testConfig, waitForStatus } from "./helpers.js";

describeDb("login sessions in server runs", () => {
  let server: Server;
  let baseUrl: string;
  let worker: Worker | undefined;

  // Echoes the Cookie header, so a step can assert what the browser context sent.
  beforeAll(async () => {
    server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<h1>${req.headers.cookie ?? "none"}</h1>`));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(resetDatabase);
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
  });

  async function seed() {
    const seeded = await seedRun({ baseUrl, steps: [{ id: "s1", action: "goto", url: "/" }, { id: "s2", action: "assertText", selector: "h1", expected: "sid=from-session" }] });
    const db = getDb();
    const run = await db.run.findUniqueOrThrow({ where: { id: seeded.runId } });
    const user = await db.user.create({ data: { id: `mina-${Date.now()}`, name: "Mina Park", email: `mina-${Date.now()}@example.com`, emailVerified: true } });
    const other = await db.user.create({ data: { id: `leo-${Date.now()}`, name: "Leo Kim", email: `leo-${Date.now()}@example.com`, emailVerified: true } });
    await db.environment.update({ where: { id: run.environmentId! }, data: { useAuthSession: true } });
    await db.run.update({ where: { id: run.id }, data: { requestedById: user.id } });
    return { ...seeded, environmentId: run.environmentId!, userId: user.id, otherId: other.id };
  }

  async function saveSession(workspaceId: string, environmentId: string, userId: string, value: string) {
    const state = { cookies: [{ name: "sid", value, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] };
    const plain = JSON.stringify(state);
    const key = parseEncryptionKey(process.env.DEFE2END_ENCRYPTION_KEY);
    await getDb().authSession.create({
      data: { workspaceId, environmentId, userId, encryptedState: encryptSecret(plain, key), cookieCount: 1, sizeBytes: plain.length, savedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) },
    });
  }

  async function start() {
    worker = createWorker(getDb(), await testConfig());
    await worker.start();
  }

  it("puts the requester's own session into the browser context", async () => {
    const { runId, workspaceId, environmentId, userId, otherId } = await seed();
    await saveSession(workspaceId, environmentId, otherId, "someone-else");
    await saveSession(workspaceId, environmentId, userId, "from-session");
    await start();
    const run = await waitForStatus(runId, ["passed", "failed", "error"]);
    expect(run).toMatchObject({ status: "passed", errorCode: null });
  });

  it("ends the run auth_session_missing when only someone else's session exists", async () => {
    const { runId, workspaceId, environmentId, otherId } = await seed();
    await saveSession(workspaceId, environmentId, otherId, "from-session");
    await start();
    const run = await waitForStatus(runId, ["passed", "failed", "error"]);
    expect(run).toMatchObject({ status: "error", errorCode: "auth_session_missing" });
  });
});
