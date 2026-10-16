import { describe, expect, it } from "vitest";
import { createDbClient } from "./index.js";

describe("createDbClient", () => {
  it("requires a database URL", () => {
    expect(() => createDbClient("")).toThrow("DATABASE_URL");
  });

  it("creates a client without connecting", async () => {
    const db = createDbClient("postgresql://user:pass@localhost:5432/none");
    expect(typeof db.heartbeat.create).toBe("function");
    await db.$disconnect();
  });
});
