import { describe, expect, it } from "vitest";
import { heartbeatIntervalMs, loadConfig } from "./config.js";

describe("heartbeatIntervalMs", () => {
  it("defaults to 10 seconds", () => {
    expect(heartbeatIntervalMs(undefined)).toBe(10_000);
  });

  it("accepts an explicit value", () => {
    expect(heartbeatIntervalMs("2500")).toBe(2_500);
  });

  it("rejects invalid values", () => {
    expect(() => heartbeatIntervalMs("abc")).toThrow();
    expect(() => heartbeatIntervalMs("10")).toThrow();
  });
});

describe("runAttempts", () => {
  const key = Buffer.alloc(32, 1).toString("base64");
  const load = (raw?: string) => loadConfig({ DEFE2END_ENCRYPTION_KEY: key, ...(raw === undefined ? {} : { RUN_RETRY_ATTEMPTS: raw }) }).runAttempts;

  it("comes from RUN_RETRY_ATTEMPTS, defaulting to 2 and falling back to 2 when invalid", () => {
    expect(load()).toBe(2);
    expect(load("1")).toBe(1);
    expect(load("3")).toBe(3);
    expect(load("zero")).toBe(2);
    expect(load("0")).toBe(2);
  });
});
