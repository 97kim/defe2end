// Claim, ownership and cancel rules on a real Postgres (stage 3 contract sections 3, 4.1, 4.2).
import { claimNextRun, createDbClient, finishRun, heartbeat, isGroupChildStartable, reapExpiredRuns, recordStepResult, registerArtifact, requestCancel } from "@defe2end/db";
import { afterAll, beforeEach, expect, it } from "vitest";
import { CLAIM, describeDb, getDb, resetDatabase, seedGroup, seedRun } from "./helpers.js";

const STEPS = [{ id: "s1", action: "goto" as const, url: "/" }];
const BASE = "http://127.0.0.1:9";

async function expireLease(runId: string) {
  await getDb().$executeRaw`UPDATE "Run" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE id = ${runId}`;
}

const step = { index: 0, stepId: "s1", action: "goto", status: "passed" as const, attempts: 1, startedAt: new Date().toISOString(), durationMs: 5 };

describeDb("claim", () => {
  const second = createDbClient();
  beforeEach(resetDatabase);
  afterAll(() => second.$disconnect());

  it("two workers racing never claim the same run", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await seedRun({ baseUrl: BASE, steps: STEPS })).runId);
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => claimNextRun(i % 2 ? second : getDb(), { ...CLAIM, workerId: `w${i % 2}` })));
    const claimed = claims.filter((c) => c !== null).map((c) => c.id);
    expect(claimed.sort()).toEqual([...ids].sort());
    expect(new Set(claims.filter((c) => c).map((c) => c!.claimToken)).size).toBe(5);
  });

  it("respects the global limit under concurrency", async () => {
    for (let i = 0; i < 4; i++) await seedRun({ baseUrl: BASE, steps: STEPS });
    const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => claimNextRun(i % 2 ? second : getDb(), { ...CLAIM, maxConcurrentRuns: 2 })));
    expect(claims.filter(Boolean)).toHaveLength(2);
  });

  it("skips a workspace at its limit and takes the next oldest elsewhere", async () => {
    const a1 = await seedRun({ baseUrl: BASE, steps: STEPS });
    const a2 = await seedRun({ baseUrl: BASE, steps: STEPS, workspaceId: a1.workspaceId });
    const b = await seedRun({ baseUrl: BASE, steps: STEPS });
    expect((await claimNextRun(getDb(), { ...CLAIM, workspaceConcurrency: 1 }))?.id).toBe(a1.runId);
    expect((await claimNextRun(getDb(), { ...CLAIM, workspaceConcurrency: 1 }))?.id).toBe(b.runId);
    expect(await claimNextRun(getDb(), { ...CLAIM, workspaceConcurrency: 1 })).toBeNull();
    expect((await getDb().run.findUniqueOrThrow({ where: { id: a2.runId } })).status).toBe("queued");
  });

  it("never claims a desktop run, and desktop runs don't count toward the server limits", async () => {
    const desktop = await seedRun({ baseUrl: BASE, steps: STEPS });
    await getDb().run.update({ where: { id: desktop.runId }, data: { location: "desktop" } });
    expect(await claimNextRun(getDb(), CLAIM)).toBeNull();
    await getDb().run.update({ where: { id: desktop.runId }, data: { status: "running" } });
    const server = await seedRun({ baseUrl: BASE, steps: STEPS, workspaceId: desktop.workspaceId });
    expect((await claimNextRun(getDb(), { ...CLAIM, maxConcurrentRuns: 1, workspaceConcurrency: 1 }))?.id).toBe(server.runId);
  });

  it("the group start condition is the same one the claim uses", async () => {
    const { runIds } = await seedGroup({ size: 2, mode: "sequential", continueOnFailure: false });
    expect(await isGroupChildStartable(getDb(), runIds[0]!)).toBe(true);
    expect(await isGroupChildStartable(getDb(), runIds[1]!)).toBe(false);
    await getDb().run.update({ where: { id: runIds[0]! }, data: { status: "passed" } });
    expect(await isGroupChildStartable(getDb(), runIds[1]!)).toBe(true);
    await getDb().run.update({ where: { id: runIds[0]! }, data: { status: "failed" } });
    expect(await isGroupChildStartable(getDb(), runIds[1]!)).toBe(false);
    expect(await isGroupChildStartable(getDb(), "missing")).toBe(false);
  });
});

describeDb("ownership: late writes are ignored", () => {
  beforeEach(resetDatabase);

  it("an expired lease can't heartbeat, store steps, register artifacts or finish", async () => {
    const { runId, workspaceId } = await seedRun({ baseUrl: BASE, steps: STEPS });
    const claimed = (await claimNextRun(getDb(), CLAIM))!;
    expect(await heartbeat(getDb(), runId, claimed.claimToken, 30_000)).toEqual({ owned: true, cancelRequested: false });
    await expireLease(runId);
    const before = await getDb().run.findUniqueOrThrow({ where: { id: runId } });

    expect(await heartbeat(getDb(), runId, claimed.claimToken, 30_000)).toEqual({ owned: false });
    expect(await recordStepResult(getDb(), runId, claimed.claimToken, step)).toBe(false);
    const artifact = { workspaceId, kind: "screenshot" as const, name: "x", storageKey: "k/x.png", contentType: "image/png", sizeBytes: 1 };
    expect(await registerArtifact(getDb(), runId, claimed.claimToken, artifact)).toBeNull();
    expect(await finishRun(getDb(), runId, claimed.claimToken, { status: "passed" })).toBe(false);

    const after = await getDb().run.findUniqueOrThrow({ where: { id: runId }, include: { stepResults: true, artifacts: true } });
    expect(after.leaseExpiresAt).toEqual(before.leaseExpiresAt); // not extended
    expect(after.status).toBe("running");
    expect(after.stepResults).toEqual([]);
    expect(after.artifacts).toEqual([]);
  });

  it("another claim token can't write", async () => {
    const { runId } = await seedRun({ baseUrl: BASE, steps: STEPS });
    await claimNextRun(getDb(), CLAIM);
    expect(await recordStepResult(getDb(), runId, "not-the-token", step)).toBe(false);
    expect(await finishRun(getDb(), runId, "not-the-token", { status: "passed" })).toBe(false);
  });

  it("an expired lease ends as error(worker_lost) and is never claimed again", async () => {
    const { runId } = await seedRun({ baseUrl: BASE, steps: STEPS });
    const claimed = (await claimNextRun(getDb(), CLAIM))!;
    expect(await reapExpiredRuns(getDb())).toEqual([]); // live lease untouched
    await expireLease(runId);
    const [first, second] = await Promise.all([reapExpiredRuns(getDb()), reapExpiredRuns(getDb())]);
    expect([...first, ...second]).toEqual([runId]);
    const run = await getDb().run.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: "error", errorCode: "worker_lost" });
    expect(await claimNextRun(getDb(), CLAIM)).toBeNull();
    expect(await finishRun(getDb(), runId, claimed.claimToken, { status: "passed" })).toBe(false);
  });
});

describeDb("cancel", () => {
  beforeEach(resetDatabase);

  it("a queued run is cancelled at once and can't be claimed; repeating gives the same answer", async () => {
    const { runId, workspaceId } = await seedRun({ baseUrl: BASE, steps: STEPS });
    const first = await requestCancel(getDb(), workspaceId, runId);
    expect(first?.status).toBe("cancelled");
    expect(await requestCancel(getDb(), workspaceId, runId)).toEqual(first);
    expect(await claimNextRun(getDb(), CLAIM)).toBeNull();
  });

  it("is scoped to the workspace", async () => {
    const { runId } = await seedRun({ baseUrl: BASE, steps: STEPS });
    const other = await seedRun({ baseUrl: BASE, steps: STEPS });
    expect(await requestCancel(getDb(), other.workspaceId, runId)).toBeNull();
  });

  it("a running run gets a cancel request; a verdict committed first still wins", async () => {
    const { runId, workspaceId } = await seedRun({ baseUrl: BASE, steps: STEPS });
    const claimed = (await claimNextRun(getDb(), CLAIM))!;
    const requested = await requestCancel(getDb(), workspaceId, runId);
    expect(requested).toMatchObject({ status: "running", finishedAt: null });
    expect(requested?.cancelRequestedAt).toBeInstanceOf(Date);
    expect(await heartbeat(getDb(), runId, claimed.claimToken, 30_000)).toEqual({ owned: true, cancelRequested: true });
    // The worker's "passed" commits before it noticed the request: completion wins, the request stays visible.
    expect(await finishRun(getDb(), runId, claimed.claimToken, { status: "passed" })).toBe(true);
    const run = await getDb().run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("passed");
    expect(run.cancelRequestedAt).toEqual(requested?.cancelRequestedAt);
    expect((await requestCancel(getDb(), workspaceId, runId))?.status).toBe("passed");
  });

  it("a terminal status never changes again", async () => {
    const { runId } = await seedRun({ baseUrl: BASE, steps: STEPS });
    const claimed = (await claimNextRun(getDb(), CLAIM))!;
    const [a, b] = await Promise.all([
      finishRun(getDb(), runId, claimed.claimToken, { status: "cancelled" }),
      finishRun(getDb(), runId, claimed.claimToken, { status: "passed" }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const status = (await getDb().run.findUniqueOrThrow({ where: { id: runId } })).status;
    expect(await finishRun(getDb(), runId, claimed.claimToken, { status: "failed" })).toBe(false);
    expect((await getDb().run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(status);
  });

  it("cancel racing a claim: either cancelled and unclaimed, or claimed with the request recorded", async () => {
    for (let i = 0; i < 10; i++) {
      await resetDatabase();
      const { runId, workspaceId } = await seedRun({ baseUrl: BASE, steps: STEPS });
      const [claimed, cancel] = await Promise.all([claimNextRun(getDb(), CLAIM), requestCancel(getDb(), workspaceId, runId)]);
      if (claimed) expect(cancel).toMatchObject({ status: "running", cancelRequestedAt: expect.any(Date) });
      else expect(cancel?.status).toBe("cancelled");
    }
  });
});
