import { describe, expect, it } from "vitest";
import { apiV1CreateRunSchema, apiV1ErrorSchema, apiV1Passed, apiV1RunSchema, idempotencyKeySchema, notificationPayloadSchema, valueSubjectSchema } from "./index.js";

describe("api v1", () => {
  it("accepts the three request shapes and server location only", () => {
    expect(apiV1CreateRunSchema.safeParse({ environmentId: "e", scenarioId: "s" }).success).toBe(true);
    expect(apiV1CreateRunSchema.safeParse({ environmentId: "e", scenarioIds: ["a", "b"], mode: "parallel" }).success).toBe(true);
    expect(apiV1CreateRunSchema.safeParse({ environmentId: "e", tag: "smoke", continueOnFailure: true }).success).toBe(true);
    expect(apiV1CreateRunSchema.safeParse({ environmentId: "e", scenarioId: "s", location: "server" }).success).toBe(true);
    expect(apiV1CreateRunSchema.safeParse({ environmentId: "e", scenarioId: "s", location: "desktop" }).success).toBe(false);
    expect(apiV1CreateRunSchema.safeParse({ environmentId: "e", scenarioId: "s", tag: "x" }).success).toBe(false);
    expect(apiV1CreateRunSchema.safeParse({ environmentId: "e", scenarioIds: [] }).success).toBe(false);
    expect(apiV1CreateRunSchema.safeParse({ environmentId: "e", tag: "smoke", options: { failOnWarning: true, video: true } }).success).toBe(true);
    expect(apiV1CreateRunSchema.safeParse({ environmentId: "e", scenarioId: "s", options: { retries: 1 } }).success).toBe(false);
  });

  it("keeps Idempotency-Key at 1–128 characters", () => {
    expect(idempotencyKeySchema.safeParse("").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("x".repeat(128)).success).toBe(true);
    expect(idempotencyKeySchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("has fixed response and error shapes; only passed passes", () => {
    const run = { id: "r", kind: "group", status: "passed", startedAt: "2026-10-14T00:00:00.000Z", finishedAt: null, warningCount: 1, failOnWarning: false, passed: true, url: null, children: [{ id: "c", scenarioId: "s", status: "passed", url: null }] };
    expect(apiV1RunSchema.parse(run)).toEqual(run);
    expect(apiV1RunSchema.safeParse({ ...run, extra: 1 }).success).toBe(false);
    expect(apiV1ErrorSchema.safeParse({ error: { code: "too_many_waits", message: "Wait later" } }).success).toBe(true);
    expect(apiV1ErrorSchema.safeParse({ error: { code: "nope", message: "" } }).success).toBe(false);
    expect(apiV1Passed({ status: "passed", warningCount: 1, failOnWarning: false })).toBe(true);
    expect(apiV1Passed({ status: "passed", warningCount: 1, failOnWarning: true })).toBe(false);
    expect(apiV1Passed({ status: "passed", warningCount: 0, failOnWarning: true })).toBe(true);
    expect(apiV1Passed({ status: "failed", warningCount: 0, failOnWarning: false })).toBe(false);
  });

  it("value subjects and notification bodies have one shape each", () => {
    expect(valueSubjectSchema.safeParse({ kind: "schedule", scheduleId: "s" }).success).toBe(true);
    expect(valueSubjectSchema.safeParse({ kind: "bot", userId: "u" }).success).toBe(false);
    expect(notificationPayloadSchema.safeParse({ kind: "test", webhookName: "ops" }).success).toBe(true);
    expect(
      notificationPayloadSchema.safeParse({ kind: "scheduleFire", scheduleFireId: "f", scheduleId: "s", scheduleName: "Nightly", status: "missed", reasonCode: null, scheduledFor: "2026-10-14T00:00:00.000Z", missedUntil: "2026-10-14T03:00:00.000Z", missedCount: 4, url: null }).success,
    ).toBe(true);
  });
});
