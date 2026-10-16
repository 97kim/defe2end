import { describe, expect, it } from "vitest";
import { KNOWN_MIGRATIONS } from "./generated/migrations.js";
import { assertServerVersion, compareMigrations, MigrationMismatchError } from "./instance-state.js";
import type { PrismaClient } from "./generated/prisma/client.js";

describe("compareMigrations", () => {
  it("knows this build's migrations, including the latest", () => {
    expect(KNOWN_MIGRATIONS.length).toBeGreaterThan(0);
    expect(compareMigrations([...KNOWN_MIGRATIONS])).toEqual({ unknown: [], missing: [] });
  });

  it("reports migrations not applied yet and ones from a newer version", () => {
    expect(compareMigrations(["a", "c"], ["a", "b"])).toEqual({ unknown: ["c"], missing: ["b"] });
  });

  it("tells to run migrate when only behind, and to use the matching images when ahead", () => {
    expect(new MigrationMismatchError([], ["b"]).message).toContain("Run this version's migrate first");
    expect(new MigrationMismatchError(["c"], []).message).toContain("Run the images of the version");
  });
});

describe("assertServerVersion", () => {
  const dbWith = (migratedByVersion: string | null) =>
    ({ instanceSetting: { findUnique: async () => ({ migratedByVersion }) } }) as unknown as PrismaClient;

  it("passes when this release's migrate ran last, and for development builds", async () => {
    await expect(assertServerVersion(dbWith("1.2.0"), "1.2.0")).resolves.toBeUndefined();
    await expect(assertServerVersion(dbWith("1.1.0"), "0.0.0")).resolves.toBeUndefined();
  });

  it("refuses another release, and a database no release migrated", async () => {
    await expect(assertServerVersion(dbWith("1.1.0"), "1.2.0")).rejects.toThrow("last migrated by version 1.1.0");
    await expect(assertServerVersion(dbWith(null), "1.2.0")).rejects.toThrow("an unknown version");
  });
});
