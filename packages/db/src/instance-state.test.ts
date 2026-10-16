import { describe, expect, it } from "vitest";
import { KNOWN_MIGRATIONS } from "./generated/migrations.js";
import { compareMigrations, MigrationMismatchError } from "./instance-state.js";

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
