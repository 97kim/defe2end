import { describe, expect, it } from "vitest";
import { capMcpList, capMcpText, isAllowedBrowserUrl, MCP_BROWSER_TOOL_NAMES, MCP_OUTPUT_LIMITS, MCP_TOOL_NAMES, MCP_TOOLS, mcpSource, mcpToolInputSchemas } from "./index.js";

const step = { id: "s1", action: "goto", url: "https://a.test" };

describe("MCP_TOOLS", () => {
  it("has no destructive tool", () => {
    for (const name of MCP_TOOL_NAMES) expect(MCP_TOOLS[name].annotations.destructiveHint, name).toBe(false);
  });

  it("has no delete, cancel or stop tool", () => {
    for (const name of MCP_TOOL_NAMES) expect(name).not.toMatch(/delete|remove|cancel|stop|archive|revoke/);
  });

  it("lists exactly the contract's tools", () => {
    expect([...MCP_TOOL_NAMES].sort()).toEqual(
      [
        "list_workspaces", "list_sites", "list_environments", "list_scenarios", "get_scenario", "create_scenario", "update_scenario", "clone_scenario",
        "run_scenario", "run_steps", "get_run", "list_schedules", "create_schedule", "update_schedule",
        "browser_navigate", "browser_click", "browser_fill", "browser_hover", "browser_press", "browser_scroll", "browser_query_dom", "browser_page_text",
        "browser_screenshot", "browser_tabs", "browser_tab_new", "browser_tab_activate",
      ].sort(),
    );
    expect(MCP_BROWSER_TOOL_NAMES.every((n) => n.startsWith("browser_"))).toBe(true);
  });

  it("marks read tools read-only and write tools not", () => {
    expect(MCP_TOOLS.get_scenario.annotations.readOnlyHint).toBe(true);
    expect(MCP_TOOLS.browser_page_text.annotations.readOnlyHint).toBe(true);
    expect(MCP_TOOLS.create_scenario.annotations.readOnlyHint).toBe(false);
    expect(MCP_TOOLS.run_scenario.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(MCP_TOOLS.browser_click.annotations.readOnlyHint).toBe(false);
  });

  it("uses the input schema registered in the table", () => {
    for (const name of MCP_TOOL_NAMES) expect(MCP_TOOLS[name].input).toBe(mcpToolInputSchemas[name]);
  });
});

describe("tool inputs", () => {
  it("validates steps with the step schema", () => {
    const base = { workspaceId: "w", siteId: "s", name: "Login" };
    expect(mcpToolInputSchemas.create_scenario.safeParse({ ...base, steps: [step] }).success).toBe(true);
    expect(mcpToolInputSchemas.create_scenario.safeParse({ ...base, steps: [{ id: "s1", action: "click" }] }).success).toBe(false);
    expect(mcpToolInputSchemas.create_scenario.safeParse({ ...base, steps: [{ id: "s1", action: "nope" }] }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(mcpToolInputSchemas.get_scenario.safeParse({ workspaceId: "w", scenarioId: "x", extra: 1 }).success).toBe(false);
  });

  it("needs something to change in update_scenario", () => {
    expect(mcpToolInputSchemas.update_scenario.safeParse({ workspaceId: "w", scenarioId: "x", updatedAt: "2026-10-15T00:00:00.000Z" }).success).toBe(false);
    expect(mcpToolInputSchemas.update_scenario.safeParse({ workspaceId: "w", scenarioId: "x", updatedAt: "2026-10-15T00:00:00.000Z", name: "New" }).success).toBe(true);
    expect(mcpToolInputSchemas.update_scenario.safeParse({ workspaceId: "w", scenarioId: "x", name: "New" }).success).toBe(false);
  });

  it("refuses an empty run_steps and non-CI run options", () => {
    expect(mcpToolInputSchemas.run_steps.safeParse({ workspaceId: "w", environmentId: "e", steps: [] }).success).toBe(false);
    expect(mcpToolInputSchemas.run_steps.safeParse({ workspaceId: "w", environmentId: "e", steps: [step], location: "desktop", options: { video: true } }).success).toBe(true);
    expect(mcpToolInputSchemas.run_scenario.safeParse({ workspaceId: "w", scenarioId: "x", environmentId: "e", options: { failOnWarning: true } }).success).toBe(false);
  });

  it("caps get_run wait at 25 seconds", () => {
    expect(mcpToolInputSchemas.get_run.safeParse({ workspaceId: "w", runId: "r", wait: 25 }).success).toBe(true);
    expect(mcpToolInputSchemas.get_run.safeParse({ workspaceId: "w", runId: "r", wait: 26 }).success).toBe(false);
  });

  it("needs exactly one schedule target", () => {
    const base = { workspaceId: "w", name: "Nightly", environmentId: "e", cron: "0 3 * * *", timezone: "Asia/Seoul" };
    expect(mcpToolInputSchemas.create_schedule.safeParse({ ...base, scenarioIds: ["a"] }).success).toBe(true);
    expect(mcpToolInputSchemas.create_schedule.safeParse({ ...base, tagId: "t" }).success).toBe(true);
    expect(mcpToolInputSchemas.create_schedule.safeParse(base).success).toBe(false);
    expect(mcpToolInputSchemas.create_schedule.safeParse({ ...base, scenarioIds: ["a"], tagId: "t" }).success).toBe(false);
  });

  it("can't change a schedule's environment or values, but can turn it off", () => {
    expect(mcpToolInputSchemas.update_schedule.safeParse({ workspaceId: "w", scheduleId: "s", environmentId: "e2" }).success).toBe(false);
    expect(mcpToolInputSchemas.update_schedule.safeParse({ workspaceId: "w", scheduleId: "s", variables: {} }).success).toBe(false);
    expect(mcpToolInputSchemas.update_schedule.safeParse({ workspaceId: "w", scheduleId: "s", enabled: false }).success).toBe(true);
    expect(mcpToolInputSchemas.update_schedule.safeParse({ workspaceId: "w", scheduleId: "s", scenarioIds: ["a"], tagId: "t" }).success).toBe(false);
  });

  it("allows only the nine press keys", () => {
    expect(mcpToolInputSchemas.browser_press.safeParse({ key: "Enter" }).success).toBe(true);
    expect(mcpToolInputSchemas.browser_press.safeParse({ key: "Control+A" }).success).toBe(false);
    expect(mcpToolInputSchemas.browser_press.safeParse({ key: "a" }).success).toBe(false);
  });

  it("needs exactly one scroll target", () => {
    expect(mcpToolInputSchemas.browser_scroll.safeParse({ to: "bottom" }).success).toBe(true);
    expect(mcpToolInputSchemas.browser_scroll.safeParse({ by: -400 }).success).toBe(true);
    expect(mcpToolInputSchemas.browser_scroll.safeParse({}).success).toBe(false);
    expect(mcpToolInputSchemas.browser_scroll.safeParse({ to: "top", selector: "#a" }).success).toBe(false);
  });

  it("caps query_dom at 20 elements", () => {
    expect(mcpToolInputSchemas.browser_query_dom.safeParse({ selector: "a", limit: 20 }).success).toBe(true);
    expect(mcpToolInputSchemas.browser_query_dom.safeParse({ selector: "a", limit: 21 }).success).toBe(false);
  });
});

describe("helpers", () => {
  it("allows only http and https navigation", () => {
    expect(isAllowedBrowserUrl("https://a.test/x")).toBe(true);
    expect(isAllowedBrowserUrl("http://localhost:3000")).toBe(true);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "data:text/html,x", "not a url"]) expect(isAllowedBrowserUrl(url)).toBe(false);
  });

  it("caps text and lists", () => {
    expect(capMcpText("short")).toBe("short");
    const long = capMcpText("x".repeat(MCP_OUTPUT_LIMITS.textChars + 500));
    expect(long.length).toBe(MCP_OUTPUT_LIMITS.textChars);
    expect(long).toMatch(/more characters cut\)$/);
    const list = capMcpList(Array.from({ length: 150 }, (_, i) => i));
    expect(list).toMatchObject({ truncated: true, total: 150 });
    expect(list.items).toHaveLength(MCP_OUTPUT_LIMITS.listItems);
  });

  it("names the scenario source after the client", () => {
    expect(mcpSource("claude")).toBe("mcp:claude");
  });
});
