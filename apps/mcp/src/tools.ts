// What `defe2end-mcp` advertises (shared `MCP_TOOLS`: names, input schemas, annotations) and how socket replies
// become tool results: a human-readable summary + the JSON, lists capped, text capped and redacted once more.
import { capMcpList, capMcpText, MCP_OUTPUT_LIMITS, MCP_TOOLS, redactText, type McpSocketError, type McpToolName } from "@defe2end/shared";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const DESCRIPTIONS: Record<McpToolName, string> = {
  list_workspaces: "List the defE2End workspaces you belong to.",
  list_sites: "List the sites of a workspace.",
  list_environments: "List the environments (base URLs) of a workspace, optionally of one site. Secret variable values are never included.",
  list_scenarios: "List scenarios of a workspace with search, tag filter and latest status. Paged with nextCursor.",
  get_scenario: "Get one scenario with its steps and `updatedAt` (needed by update_scenario).",
  create_scenario: "Create a scenario. Steps are validated against the action spec. There is no delete tool.",
  update_scenario: "Change a scenario. Pass the `updatedAt` from get_scenario; on `conflict` someone saved in between, so call get_scenario again and redo the change. `steps` replaces the whole step list.",
  clone_scenario: "Copy a scenario (steps, site, tags).",
  run_scenario: "Start a scenario run and return the run id right away. Poll it with get_run.",
  run_steps: "Start a trial run of unsaved steps (nothing is stored as a scenario) and return the run id right away.",
  get_run: "Get a run's status and step results. `wait` (max 25 s) waits for it to finish.",
  list_schedules: "List the schedules of a workspace.",
  create_schedule: "Create a schedule for listed scenarios or a tag (exactly one). Schedule-only values are set on the web.",
  update_schedule: "Change a schedule; `enabled: false` turns it off. The environment can't be changed here and there is no delete.",
  browser_navigate: "Open an http(s) URL in the defE2End side browser.",
  browser_click: "Click the element matching a CSS selector in the side browser.",
  browser_fill: "Type a value into an input in the side browser. Password fields are refused.",
  browser_hover: "Hover the element matching a CSS selector.",
  browser_press: "Press one key (Enter, Escape, Tab, Backspace, arrows, Space).",
  browser_scroll: "Scroll to the top/bottom, by pixels, or to a selector (exactly one).",
  browser_query_dom: "Find elements by CSS selector (max 20). Input values and secret-looking attributes are removed.",
  browser_page_text: "Read the visible text of the active tab (max 20,000 characters, masked).",
  browser_screenshot: "Take a screenshot of the active tab (long edge 1,024 px). Password and card fields are covered.",
  browser_tabs: "List the side browser's tabs.",
  browser_tab_new: "Open a new tab, optionally at an http(s) URL.",
  browser_tab_activate: "Switch to a tab.",
};

function inputJsonSchema(schema: z.ZodType): Tool["inputSchema"] {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return { ...json, type: "object" } as Tool["inputSchema"];
}

export function listTools(): Tool[] {
  return (Object.keys(MCP_TOOLS) as McpToolName[]).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: inputJsonSchema(MCP_TOOLS[name].input),
    annotations: { ...MCP_TOOLS[name].annotations },
  }));
}

/** Caps every array in the reply at the list limit; returns the paths that were cut. */
function capLists(value: unknown, path: string, notes: string[]): unknown {
  if (Array.isArray(value)) {
    const capped = capMcpList(value, MCP_OUTPUT_LIMITS.listItems);
    if (capped.truncated) notes.push(`${path || "result"}: showing ${capped.items.length} of ${capped.total}`);
    return capped.items.map((v, i) => capLists(v, `${path}[${i}]`, notes));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capLists(v, path ? `${path}.${k}` : k, notes)]));
  }
  return value;
}

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
function field(obj: unknown, ...keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = str((obj as Record<string, unknown>)[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}
function firstArray(value: unknown): { key: string; items: unknown[] } | undefined {
  if (Array.isArray(value)) return { key: "items", items: value };
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) if (Array.isArray(v)) return { key, items: v };
  }
  return undefined;
}

function summarize(tool: McpToolName, result: unknown): string {
  const obj = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const run = obj.run ?? result;
  switch (tool) {
    case "run_scenario":
    case "run_steps":
      return `Run started: ${field(run, "runId", "id") ?? "(no id)"}. Check it with get_run.`;
    case "get_run":
      return `Run ${field(run, "id", "runId") ?? ""}: ${field(run, "status") ?? "unknown status"}`.trim();
    case "create_scenario":
    case "update_scenario":
    case "clone_scenario": {
      const verb = tool === "create_scenario" ? "created" : tool === "update_scenario" ? "updated" : "copied";
      const s = obj.scenario ?? result;
      return `Scenario ${verb}: ${field(s, "name") ?? ""} (${field(s, "id") ?? "no id"}), updatedAt ${field(s, "updatedAt") ?? "unknown"}`;
    }
    case "get_scenario": {
      const s = obj.scenario ?? result;
      return `Scenario ${field(s, "name") ?? ""} (${field(s, "id") ?? ""}), updatedAt ${field(s, "updatedAt") ?? "unknown"}`;
    }
    default: {
      if (tool.startsWith("list_") || tool === "browser_tabs" || tool === "browser_query_dom") {
        const list = firstArray(result);
        if (list) return `${tool}: ${list.items.length} ${list.key}`;
      }
      return `${tool}: done`;
    }
  }
}

/** A screenshot reply's image, taken out of the JSON (the app already covered sensitive fields). */
function takeImage(result: unknown): { image?: { data: string; mimeType: string }; rest: unknown } {
  if (!result || typeof result !== "object") return { rest: result };
  const { data, image, mimeType, ...rest } = result as Record<string, unknown>;
  const b64 = typeof data === "string" ? data : typeof image === "string" ? image : undefined;
  if (!b64) return { rest: result };
  return { image: { data: b64, mimeType: typeof mimeType === "string" ? mimeType : "image/jpeg" }, rest };
}

export function formatResult(tool: McpToolName, result: unknown): CallToolResult {
  let body = result;
  let image: { data: string; mimeType: string } | undefined;
  if (tool === "browser_screenshot") ({ image, rest: body } = takeImage(result));
  const notes: string[] = [];
  const capped = capLists(body, "", notes);
  const summary = [summarize(tool, capped), ...notes.map((n) => `(list cut — ${n})`)].join("\n");
  const json = capped === undefined ? "" : `\n\n${JSON.stringify(capped, null, 2)}`;
  const text = capMcpText(redactText(summary + json));
  const content: CallToolResult["content"] = [{ type: "text", text }];
  if (image) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  return { content };
}

export function formatError(error: McpSocketError): CallToolResult {
  const keys = error.keys?.length ? `\nKeys: ${error.keys.join(", ")}` : "";
  return { isError: true, content: [{ type: "text", text: capMcpText(redactText(`[${error.code}] ${error.message}${keys}`)) }] };
}
