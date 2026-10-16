import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@defe2end/db";
import { checkHealth } from "./health";

function fakeDb(findUnique: () => Promise<unknown>) {
  return { instanceSetting: { findUnique: vi.fn(findUnique) } } as unknown as PrismaClient;
}

describe("checkHealth", () => {
  it("reports ok with the install time", async () => {
    const installedAt = new Date("2026-01-01T00:00:00Z");
    const health = await checkHealth(fakeDb(async () => ({ installedAt })), "1.2.3");
    expect(health).toEqual({ status: "ok", db: "ok", version: "1.2.3", installedAt: installedAt.toISOString() });
  });

  it("reports ok before setup", async () => {
    const health = await checkHealth(fakeDb(async () => null), "1.2.3");
    expect(health).toEqual({ status: "ok", db: "ok", version: "1.2.3", installedAt: null });
  });

  it("reports error when the database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const health = await checkHealth(fakeDb(() => Promise.reject(new Error("down"))), "1.2.3");
    expect(health).toEqual({ status: "error", db: "error", version: "1.2.3" });
  });
});
