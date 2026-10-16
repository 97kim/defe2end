// Stage 6 contract section 4: the tools `defe2end-mcp` exposes. Names, annotations and input schemas are shared by
// the MCP server (which advertises them), the desktop app (which re-validates every socket call with the same schema)
// and the server's `/api/mcp/*` routes. Destructive work (cancel, stop all, delete) is web/app only, so no tool here
// is destructive — the test pins that.
import { z } from "zod";
import { runOptionsSchema } from "./execution.js";
import { stepsSchema } from "./steps.js";

/** Every tool response is capped (section 4): summary text and list length. Longer output is cut and says so. */
export const MCP_OUTPUT_LIMITS = { textChars: 20_000, listItems: 100 } as const;

/** `get_run.wait` stays under the socket reply timeout (30 s). */
export const MCP_RUN_WAIT_MAX_SECONDS = 25;

/** Recorded as the scenario's source on create/update/clone (`mcp:claude`, `mcp:codex`, otherwise `mcp:unknown`). */
export const MCP_CLIENTS = ["claude", "codex", "unknown"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];
export function mcpSource(client: McpClient): `mcp:${McpClient}` {
  return `mcp:${client}`;
}

/** Keys `browser_press` accepts (no modifiers, no combinations). */
export const BROWSER_PRESS_KEYS = ["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"] as const;
export type BrowserPressKey = (typeof BROWSER_PRESS_KEYS)[number];

/** Browser output limits (section 5); the app enforces them before masking and replying. */
export const BROWSER_LIMITS = { pageTextChars: 20_000, outerHtmlChars: 2_000, maxElements: 20, screenshotLongEdgePx: 1_024 } as const;

/** Navigation accepts http and https only (`scheme-not-allowed` otherwise). */
export const BROWSER_ALLOWED_SCHEMES = ["http:", "https:"] as const;
export function isAllowedBrowserUrl(url: string): boolean {
  try {
    return (BROWSER_ALLOWED_SCHEMES as readonly string[]).includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

const id = z.string().min(1).max(64);
const name = z.string().trim().min(1).max(200);
const selector = z.string().min(1).max(2000);
const tags = z.array(z.string().trim().min(1).max(50)).max(20);
/** The scheme is checked by the app too (it answers `scheme-not-allowed`); the schema keeps the URL shape honest. */
const browserUrl = z.string().min(1).max(2000);
/** Where a run executes: the server's worker or this PC's desktop app. */
const location = z.enum(["server", "desktop"]);
/** Only video is a per-run choice for AI; `failOnWarning` is CI-only. */
const mcpRunOptions = runOptionsSchema.pick({ video: true });
const scheduleMode = z.enum(["sequential", "parallel"]);
const scheduleOverlap = z.enum(["skip", "allow"]);
const cron = z.string().trim().min(1).max(100);
const timezone = z.string().trim().min(1).max(64);

const atLeastOne = (keys: string[]) => (v: Record<string, unknown>) => keys.some((k) => v[k] !== undefined);
const atMostOne = (keys: string[]) => (v: Record<string, unknown>) => keys.filter((k) => v[k] !== undefined).length <= 1;

// MCP input schemas must be JSON objects, so "one of" choices are refinements on one object rather than unions.
export const mcpToolInputSchemas = {
  list_workspaces: z.strictObject({}),
  list_sites: z.strictObject({ workspaceId: id }),
  list_environments: z.strictObject({ workspaceId: id, siteId: id.optional() }),
  list_scenarios: z.strictObject({
    workspaceId: id,
    siteId: id.optional(),
    search: z.string().max(200).optional(),
    tag: z.string().max(50).optional(),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(MCP_OUTPUT_LIMITS.listItems).optional(),
    /** Opaque cursor from the previous page's `nextCursor`. */
    cursor: z.string().max(200).optional(),
  }),
  get_scenario: z.strictObject({ workspaceId: id, scenarioId: id }),
  create_scenario: z.strictObject({
    workspaceId: id,
    siteId: id,
    name,
    description: z.string().max(2000).optional(),
    steps: stepsSchema,
    tags: tags.optional(),
    retryOnFailure: z.boolean().optional(),
  }),
  /**
   * `steps` replaces the whole list. No archive/delete field, and no tags (the web sets those with its own tag
   * control). `updatedAt` is the value `get_scenario` returned: a change made since then (by a person or another
   * call) makes this a `conflict` instead of being overwritten.
   */
  update_scenario: z
    .strictObject({
      workspaceId: id,
      scenarioId: id,
      updatedAt: z.iso.datetime(),
      name: name.optional(),
      description: z.string().max(2000).optional(),
      steps: stepsSchema.optional(),
      retryOnFailure: z.boolean().optional(),
    })
    .refine(atLeastOne(["name", "description", "steps", "retryOnFailure"]), { message: "Nothing to update" }),
  /** The copy is named like the web's duplicate; rename it with `update_scenario`. */
  clone_scenario: z.strictObject({ workspaceId: id, scenarioId: id }),
  /** Returns the run id right away (no waiting); poll with `get_run`. */
  run_scenario: z.strictObject({ workspaceId: id, scenarioId: id, environmentId: id, location: location.optional(), options: mcpRunOptions.optional() }),
  /** A trial run of unsaved steps; nothing is stored as a scenario. */
  run_steps: z.strictObject({ workspaceId: id, environmentId: id, steps: stepsSchema.refine((s) => s.length > 0, { message: "At least one step" }), location: location.optional(), options: mcpRunOptions.optional() }),
  get_run: z.strictObject({ workspaceId: id, runId: id, wait: z.number().int().min(0).max(MCP_RUN_WAIT_MAX_SECONDS).optional() }),
  list_schedules: z.strictObject({ workspaceId: id }),
  /** Targets are listed scenarios or a tag — exactly one. Schedule-only values and sessions are web-only. */
  create_schedule: z
    .strictObject({
      workspaceId: id,
      name,
      environmentId: id,
      scenarioIds: z.array(id).min(1).max(MCP_OUTPUT_LIMITS.listItems).optional(),
      tagId: id.optional(),
      mode: scheduleMode.optional(),
      continueOnFailure: z.boolean().optional(),
      cron,
      timezone,
      enabled: z.boolean().optional(),
      overlap: scheduleOverlap.optional(),
    })
    .refine((v) => (v.scenarioIds === undefined) !== (v.tagId === undefined), { message: "Give scenarioIds or tagId (exactly one)" }),
  /**
   * No `environmentId` (changing it would wipe schedule-only values, which MCP must not do) and no delete.
   * Turning a schedule off is `enabled: false`.
   */
  update_schedule: z
    .strictObject({
      workspaceId: id,
      scheduleId: id,
      name: name.optional(),
      scenarioIds: z.array(id).min(1).max(MCP_OUTPUT_LIMITS.listItems).optional(),
      tagId: id.optional(),
      mode: scheduleMode.optional(),
      continueOnFailure: z.boolean().optional(),
      cron: cron.optional(),
      timezone: timezone.optional(),
      enabled: z.boolean().optional(),
      overlap: scheduleOverlap.optional(),
    })
    .refine(atLeastOne(["name", "scenarioIds", "tagId", "mode", "continueOnFailure", "cron", "timezone", "enabled", "overlap"]), { message: "Nothing to update" })
    .refine(atMostOne(["scenarioIds", "tagId"]), { message: "Give scenarioIds or tagId, not both" }),

  // Browser tools act on the side browser's active tab (only navigate may name a tab).
  browser_navigate: z.strictObject({ url: browserUrl, tabId: id.optional() }),
  browser_click: z.strictObject({ selector }),
  /** Password fields are refused (`credential-field`). */
  browser_fill: z.strictObject({ selector, value: z.string().max(10_000) }),
  browser_hover: z.strictObject({ selector }),
  browser_press: z.strictObject({ key: z.enum(BROWSER_PRESS_KEYS) }),
  /** Exactly one of: `to` an end of the page, `by` relative pixels, or a `selector` to scroll into view. */
  browser_scroll: z
    .strictObject({ to: z.enum(["top", "bottom"]).optional(), by: z.number().int().min(-100_000).max(100_000).optional(), selector: selector.optional() })
    .refine((v) => [v.to, v.by, v.selector].filter((x) => x !== undefined).length === 1, { message: "Give exactly one of to, by, selector" }),
  /** Zero matches is not an error. `includeHtml` adds masked outerHTML (2,000 chars each). */
  browser_query_dom: z.strictObject({ selector, limit: z.number().int().min(1).max(BROWSER_LIMITS.maxElements).optional(), includeHtml: z.boolean().optional() }),
  browser_page_text: z.strictObject({}),
  browser_screenshot: z.strictObject({}),
  browser_tabs: z.strictObject({}),
  browser_tab_new: z.strictObject({ url: browserUrl.optional() }),
  browser_tab_activate: z.strictObject({ tabId: id }),
} as const;

export type McpToolName = keyof typeof mcpToolInputSchemas;
export type McpToolInput<T extends McpToolName> = z.infer<(typeof mcpToolInputSchemas)[T]>;

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  /** Always false: destructive work is not exposed over MCP (section 1). */
  destructiveHint: false;
  idempotentHint: boolean;
}
export type McpToolKind = "read" | "write" | "run" | "browser";

const read = { kind: "read", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } } as const;
const write = { kind: "write", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } } as const;
const writeIdempotent = { kind: "write", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } } as const;
/** Run tools carry an idempotency key made by `defe2end-mcp`, so a retried call returns the same run. */
const run = { kind: "run", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } } as const;
const browserRead = { kind: "browser", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } } as const;
const browserAct = { kind: "browser", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } } as const;

type ToolMeta = { kind: McpToolKind; annotations: McpToolAnnotations };

export const MCP_TOOLS: { readonly [T in McpToolName]: ToolMeta & { input: (typeof mcpToolInputSchemas)[T] } } = {
  list_workspaces: { ...read, input: mcpToolInputSchemas.list_workspaces },
  list_sites: { ...read, input: mcpToolInputSchemas.list_sites },
  list_environments: { ...read, input: mcpToolInputSchemas.list_environments },
  list_scenarios: { ...read, input: mcpToolInputSchemas.list_scenarios },
  get_scenario: { ...read, input: mcpToolInputSchemas.get_scenario },
  create_scenario: { ...write, input: mcpToolInputSchemas.create_scenario },
  update_scenario: { ...writeIdempotent, input: mcpToolInputSchemas.update_scenario },
  clone_scenario: { ...write, input: mcpToolInputSchemas.clone_scenario },
  run_scenario: { ...run, input: mcpToolInputSchemas.run_scenario },
  run_steps: { ...run, input: mcpToolInputSchemas.run_steps },
  get_run: { ...read, input: mcpToolInputSchemas.get_run },
  list_schedules: { ...read, input: mcpToolInputSchemas.list_schedules },
  create_schedule: { ...write, input: mcpToolInputSchemas.create_schedule },
  update_schedule: { ...writeIdempotent, input: mcpToolInputSchemas.update_schedule },
  browser_navigate: { ...browserAct, input: mcpToolInputSchemas.browser_navigate },
  browser_click: { ...browserAct, input: mcpToolInputSchemas.browser_click },
  browser_fill: { ...browserAct, input: mcpToolInputSchemas.browser_fill },
  browser_hover: { ...browserAct, input: mcpToolInputSchemas.browser_hover },
  browser_press: { ...browserAct, input: mcpToolInputSchemas.browser_press },
  browser_scroll: { ...browserAct, input: mcpToolInputSchemas.browser_scroll },
  browser_query_dom: { ...browserRead, input: mcpToolInputSchemas.browser_query_dom },
  browser_page_text: { ...browserRead, input: mcpToolInputSchemas.browser_page_text },
  browser_screenshot: { ...browserRead, input: mcpToolInputSchemas.browser_screenshot },
  browser_tabs: { ...browserRead, input: mcpToolInputSchemas.browser_tabs },
  browser_tab_new: { ...browserAct, input: mcpToolInputSchemas.browser_tab_new },
  browser_tab_activate: { ...browserAct, input: mcpToolInputSchemas.browser_tab_activate },
};

export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS) as McpToolName[];
export const MCP_BROWSER_TOOL_NAMES = MCP_TOOL_NAMES.filter((n) => MCP_TOOLS[n].kind === "browser");
export const MCP_DOMAIN_TOOL_NAMES = MCP_TOOL_NAMES.filter((n) => MCP_TOOLS[n].kind !== "browser");
export function isMcpToolName(value: string): value is McpToolName {
  return Object.hasOwn(MCP_TOOLS, value);
}

/** Cuts `text` to the response cap, saying how much was dropped. */
export function capMcpText(text: string, max: number = MCP_OUTPUT_LIMITS.textChars): string {
  if (text.length <= max) return text;
  const note = `\n… (${text.length - max} more characters cut)`;
  return text.slice(0, Math.max(0, max - note.length)) + note;
}

/** Keeps the first `max` items and reports whether anything was dropped. */
export function capMcpList<T>(items: readonly T[], max: number = MCP_OUTPUT_LIMITS.listItems): { items: T[]; truncated: boolean; total: number } {
  return { items: items.slice(0, max), truncated: items.length > max, total: items.length };
}
