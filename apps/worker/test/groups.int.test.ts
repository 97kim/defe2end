// Group runs on a real Postgres (stage 3 contract section 4.4): sequential claim order, stopping on failure,
// aggregation under the group lock, and the safety net for a missed settle.
import { aggregateGroupStatus, claimNextRun, finishRun, reapExpiredRuns, requestCancel, settlePendingGroups } from "@defe2end/db";
import { beforeEach, describe, expect, it } from "vitest";
import { CLAIM, describeDb, getDb, resetDatabase, seedGroup } from "./helpers.js";

const read = (id: string) => getDb().run.findUniqueOrThrow({ where: { id } });
const group = (id: string) => getDb().groupRun.findUniqueOrThrow({ where: { id } });

describe("aggregateGroupStatus", () => {
  it("the worst status wins: error > timed_out > failed > cancelled > passed", () => {
    expect(aggregateGroupStatus(["passed", "passed"])).toBe("passed");
    expect(aggregateGroupStatus(["passed", "cancelled"])).toBe("cancelled");
    expect(aggregateGroupStatus(["cancelled", "failed", "passed"])).toBe("failed");
    expect(aggregateGroupStatus(["failed", "timed_out"])).toBe("timed_out");
    expect(aggregateGroupStatus(["timed_out", "error", "passed"])).toBe("error");
  });
});

describeDb("group runs", () => {
  beforeEach(resetDatabase);

  it("sequential: the next child waits until the previous one passed; the group runs, then passes", async () => {
    const g = await seedGroup({ size: 3, mode: "sequential", continueOnFailure: false });
    const first = (await claimNextRun(getDb(), CLAIM))!;
    expect(first.id).toBe(g.runIds[0]);
    expect((await group(g.groupRunId)).status).toBe("running");
    expect(await claimNextRun(getDb(), CLAIM)).toBeNull();
    await finishRun(getDb(), first.id, first.claimToken, { status: "passed" });
    const second = (await claimNextRun(getDb(), CLAIM))!;
    expect(second.id).toBe(g.runIds[1]);
    await finishRun(getDb(), second.id, second.claimToken, { status: "passed" });
    const third = (await claimNextRun(getDb(), CLAIM))!;
    expect(third.id).toBe(g.runIds[2]);
    expect((await group(g.groupRunId)).status).toBe("running");
    await finishRun(getDb(), third.id, third.claimToken, { status: "passed" });
    expect(await group(g.groupRunId)).toMatchObject({ status: "passed", finishedAt: expect.any(Date) });
  });

  it("sequential without continueOnFailure: a failure cancels the rest as group_stopped", async () => {
    const g = await seedGroup({ size: 3, mode: "sequential", continueOnFailure: false });
    const first = (await claimNextRun(getDb(), CLAIM))!;
    await finishRun(getDb(), first.id, first.claimToken, { status: "failed" });
    for (const id of g.runIds.slice(1)) expect(await read(id)).toMatchObject({ status: "cancelled", errorCode: "group_stopped", startedAt: null });
    expect(await claimNextRun(getDb(), CLAIM)).toBeNull();
    expect((await group(g.groupRunId)).status).toBe("failed");
  });

  it("sequential with continueOnFailure: every child runs in order, the group gets the worst status", async () => {
    const g = await seedGroup({ size: 3, mode: "sequential", continueOnFailure: true });
    const verdicts = ["failed", "passed", "timed_out"] as const;
    for (const [i, status] of verdicts.entries()) {
      const claimed = (await claimNextRun(getDb(), CLAIM))!;
      expect(claimed.id).toBe(g.runIds[i]);
      await finishRun(getDb(), claimed.id, claimed.claimToken, { status });
    }
    expect((await group(g.groupRunId)).status).toBe("timed_out");
  });

  it("parallel without continueOnFailure: a failure requests cancel of running children and stops queued ones", async () => {
    const g = await seedGroup({ size: 3, mode: "parallel", continueOnFailure: false });
    const a = (await claimNextRun(getDb(), CLAIM))!;
    const b = (await claimNextRun(getDb(), CLAIM))!;
    expect([a.id, b.id]).toEqual(g.runIds.slice(0, 2));
    await finishRun(getDb(), a.id, a.claimToken, { status: "error", errorCode: "browser_crashed" });
    expect(await read(b.id)).toMatchObject({ status: "running", cancelRequestedAt: expect.any(Date) });
    expect(await read(g.runIds[2]!)).toMatchObject({ status: "cancelled", errorCode: "group_stopped" });
    expect((await group(g.groupRunId)).status).toBe("running"); // waits for b
    await finishRun(getDb(), b.id, b.claimToken, { status: "cancelled" });
    expect((await group(g.groupRunId)).status).toBe("error");
  });

  it("cancelling a queued child or reaping a lost one settles the group too", async () => {
    const g = await seedGroup({ size: 2, mode: "parallel", continueOnFailure: true });
    const a = (await claimNextRun(getDb(), CLAIM))!;
    await requestCancel(getDb(), g.workspaceId, g.runIds[1]!);
    expect((await group(g.groupRunId)).status).toBe("running");
    await getDb().$executeRaw`UPDATE "Run" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE id = ${a.id}`;
    expect(await reapExpiredRuns(getDb())).toEqual([a.id]);
    expect((await group(g.groupRunId)).status).toBe("error");
  });

  it("finishing children concurrently ends the group exactly once with the aggregate", async () => {
    const g = await seedGroup({ size: 6, mode: "parallel", continueOnFailure: true });
    const claims = [];
    for (let i = 0; i < 6; i++) claims.push((await claimNextRun(getDb(), CLAIM))!);
    const statuses = ["passed", "failed", "passed", "cancelled", "passed", "passed"] as const;
    await Promise.all(claims.map((c, i) => finishRun(getDb(), c.id, c.claimToken, { status: statuses[i]! })));
    expect((await group(g.groupRunId)).status).toBe("failed");
  });

  // A child's verdict commits before its group is settled; a claim in between must not start another child.
  it("parallel without continueOnFailure: a failed sibling not yet settled blocks further claims", async () => {
    const g = await seedGroup({ size: 3, mode: "parallel", continueOnFailure: false });
    const a = (await claimNextRun(getDb(), CLAIM))!;
    await getDb().run.update({ where: { id: a.id }, data: { status: "failed", finishedAt: new Date(), leaseExpiresAt: null } });
    expect(await claimNextRun(getDb(), CLAIM)).toBeNull();
    for (const id of g.runIds.slice(1)) expect((await read(id)).status).toBe("queued");
  });

  it("sequential without continueOnFailure: a later child cancelled but not yet settled blocks the earlier ones", async () => {
    const g = await seedGroup({ size: 3, mode: "sequential", continueOnFailure: false });
    const first = (await claimNextRun(getDb(), CLAIM))!;
    await finishRun(getDb(), first.id, first.claimToken, { status: "passed" });
    // As if a cancel of the last child committed and its settle has not run yet.
    await getDb().run.update({ where: { id: g.runIds[2] }, data: { status: "cancelled", cancelRequestedAt: new Date(), finishedAt: new Date() } });
    expect(await claimNextRun(getDb(), CLAIM)).toBeNull();
    expect((await read(g.runIds[1]!)).status).toBe("queued");
  });

  it("with continueOnFailure a non-passed sibling does not block claims", async () => {
    const g = await seedGroup({ size: 2, mode: "parallel", continueOnFailure: true });
    const a = (await claimNextRun(getDb(), CLAIM))!;
    await getDb().run.update({ where: { id: a.id }, data: { status: "failed", finishedAt: new Date(), leaseExpiresAt: null } });
    expect((await claimNextRun(getDb(), CLAIM))?.id).toBe(g.runIds[1]);
  });

  it("a settle missed by a crash is caught by the safety net", async () => {
    const g = await seedGroup({ size: 2, mode: "sequential", continueOnFailure: false });
    // As if the worker died between the child's verdict and the settle.
    await getDb().run.update({ where: { id: g.runIds[0] }, data: { status: "failed", finishedAt: new Date() } });
    expect(await claimNextRun(getDb(), CLAIM)).toBeNull();
    expect(await settlePendingGroups(getDb())).toBe(1);
    expect(await read(g.runIds[1]!)).toMatchObject({ status: "cancelled", errorCode: "group_stopped" });
    expect((await group(g.groupRunId)).status).toBe("failed");
    expect(await settlePendingGroups(getDb())).toBe(0);
  });
});
