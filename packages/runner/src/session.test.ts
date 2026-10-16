// Login session (stage 4 contract section 5): the plan's storageState goes into the attempt's new context and nowhere else.
import type { StorageState } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import { execute, makePlan, noBrowserLeftFor, useFixtures } from "./test-support.js";

const fixtures = useFixtures();
const COOKIE_VALUE = "session-cookie-value-7f3a";
const TOKEN = "local-token-value-91bc";

const state = (): StorageState => ({
  cookies: [{ name: "sid", value: COOKIE_VALUE, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
  origins: [{ origin: fixtures.url, localStorage: [{ name: "token", value: TOKEN }] }],
});

describe("storageState", () => {
  it("puts cookies and localStorage into the run's context", async () => {
    const p = makePlan(
      fixtures.url,
      [
        { id: "s1", action: "goto", url: "/session.html" },
        { id: "s2", action: "assertText", selector: "[data-testid=cookie]", expected: `sid=${COOKIE_VALUE}` },
        { id: "s3", action: "assertText", selector: "[data-testid=local]", expected: TOKEN },
      ],
      { storageState: state() },
    );
    const { verdict, results } = await execute(p);
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed"]);
    expect(verdict.status).toBe("passed");
    await noBrowserLeftFor(p.runId);
  });

  it("never puts the session into events, logs or artifacts", async () => {
    // A failing assertion makes the runner report expected/actual and capture a screenshot.
    const p = makePlan(
      fixtures.url,
      [
        { id: "s1", action: "goto", url: "/session.html" },
        { id: "s2", action: "assertText", selector: "h1", expected: "never" },
      ],
      { storageState: state(), capture: { video: false, traceOnFailure: true } },
    );
    const { verdict, events, files } = await execute(p);
    expect(verdict.status).toBe("failed");
    const emitted = JSON.stringify([verdict, events]);
    expect(emitted).not.toContain(COOKIE_VALUE);
    expect(emitted).not.toContain(TOKEN);
    for (const f of files.filter((f) => f.kind === "log")) expect(f.bytes.toString()).not.toContain(COOKIE_VALUE);
  });

  it("masks session values in a failed step's actual text and records no trace", async () => {
    // The page prints the cookie and token, so the failing assertions' actual text holds them.
    const p = makePlan(
      fixtures.url,
      [
        { id: "s1", action: "goto", url: "/session.html" },
        { id: "s2", action: "assertText", selector: "[data-testid=cookie]", expected: "never", optional: true },
        { id: "s3", action: "assertText", selector: "[data-testid=local]", expected: "never" },
      ],
      { storageState: state(), capture: { video: false, traceOnFailure: true } },
    );
    const { verdict, events, files } = await execute(p);
    expect(verdict.status).toBe("failed");
    const emitted = JSON.stringify([verdict, events]);
    expect(emitted).not.toContain(COOKIE_VALUE);
    expect(emitted).not.toContain(TOKEN);
    expect(files.filter((f) => f.kind === "trace")).toEqual([]);
  });

  it("refuses a malformed session without naming its values", async () => {
    const bad = { cookies: [{ name: "sid", value: COOKIE_VALUE }], origins: [] } as unknown as StorageState;
    const { verdict, results } = await execute(makePlan(fixtures.url, [{ id: "s1", action: "goto", url: "/session.html" }], { storageState: bad }));
    expect(verdict.status).toBe("error");
    expect(verdict.errorMessage).toContain("storageState");
    expect(verdict.errorMessage).not.toContain(COOKIE_VALUE);
    expect(results).toEqual([]);
  });
});
