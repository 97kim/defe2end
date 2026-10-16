// Pure helpers shared by the scenario API and the step editor (browser-safe).
import {
  exportedScenarioSchema,
  SCENARIO_EXPORT_FORMAT,
  STEP_FORMAT_VERSION,
  type ExportedScenario,
  type ScenarioExport,
  type Step,
} from "@defe2end/shared";
import { z } from "zod";
import { pruneStep } from "./step-fields";

export const SCENARIO_NAME_MAX = 200;
export const TAG_NAME_MAX = 100;

export const scenarioNameSchema = z.string().trim().min(1, "Name is required").max(SCENARIO_NAME_MAX);
export const tagNameSchema = z.string().trim().min(1, "Tag name is required").max(TAG_NAME_MAX);

/** One limit for both directions, so anything exported can be imported again. */
export const SCENARIO_TRANSFER_MAX = 1000;

/**
 * The shared export entry, with the same name and tag rules as create/update
 * (trimmed, whitespace-only rejected).
 */
export const importedScenarioSchema = exportedScenarioSchema.extend({
  name: scenarioNameSchema,
  tags: z.array(tagNameSchema).default([]),
});

/** "Copy of …", cut so the result still fits the name limit. */
export function copyName(name: string): string {
  const prefix = "Copy of ";
  return prefix + name.slice(0, SCENARIO_NAME_MAX - prefix.length);
}

/** Moves one item; out-of-range moves return the list unchanged. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Step ids only need to be unique inside one scenario; randomUUID is missing on plain-HTTP origins. */
export function newStepId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Drops empty values; keys the action doesn't use are kept (spec section 1). */
export function cleanStep(step: Step): Step {
  return pruneStep(step);
}

export interface ExportSource {
  name: string;
  description: string;
  siteName: string;
  tagNames: string[];
  steps: unknown;
}

/** Contract section 7: sites by name, no database ids, no secret values (scenarios only hold `{{VAR}}` references). */
export function buildExport(scenarios: ExportSource[]): ScenarioExport {
  return {
    format: SCENARIO_EXPORT_FORMAT,
    formatVersion: 1,
    stepFormatVersion: STEP_FORMAT_VERSION,
    scenarios: scenarios.map((s) => ({
      name: s.name,
      description: s.description,
      site: s.siteName,
      tags: [...s.tagNames].sort(),
      steps: (s.steps as Step[]).map(cleanStep),
    })),
  };
}

/** The outer shape of an import file; each scenario is checked on its own so one bad entry doesn't sink the rest. */
export const importFileSchema = z.object({
  format: z.literal(SCENARIO_EXPORT_FORMAT, { error: `format must be "${SCENARIO_EXPORT_FORMAT}"` }),
  formatVersion: z.literal(1, { error: "formatVersion must be 1" }),
  stepFormatVersion: z.literal(STEP_FORMAT_VERSION, { error: `stepFormatVersion must be ${STEP_FORMAT_VERSION}` }),
  scenarios: z.array(z.unknown()).max(SCENARIO_TRANSFER_MAX, `An import file can hold at most ${SCENARIO_TRANSFER_MAX} scenarios`),
});

export type SkipReason = "invalid" | "site_not_found";

export interface ImportPlan {
  create: (ExportedScenario & { siteId: string })[];
  skipped: { index: number; name: string | null; reason: SkipReason; detail: string }[];
}

/** Validates every scenario and maps site names to ids. Missing sites are reported, never created. */
export function planImport(scenarios: unknown[], siteIdsByName: ReadonlyMap<string, string>): ImportPlan {
  const plan: ImportPlan = { create: [], skipped: [] };
  scenarios.forEach((raw, index) => {
    const name =
      typeof raw === "object" && raw !== null && typeof (raw as { name?: unknown }).name === "string"
        ? ((raw as { name: string }).name || null)
        : null;
    const parsed = importedScenarioSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
      plan.skipped.push({ index, name, reason: "invalid", detail });
      return;
    }
    const siteId = siteIdsByName.get(parsed.data.site);
    if (!siteId) {
      plan.skipped.push({ index, name, reason: "site_not_found", detail: parsed.data.site });
      return;
    }
    const tags = [...new Set(parsed.data.tags)];
    plan.create.push({ ...parsed.data, tags, siteId });
  });
  return plan;
}

export type LeaveChoice = "save" | "discard" | "cancel";

/**
 * The unsaved-changes guard: decides whether an action that replaces the editor may go ahead.
 * Clean editor → go. Otherwise ask; "save" goes ahead only if the save succeeded.
 * Returns how to proceed: `false` (stay), `"kept"` (saved or nothing to lose) or `"discarded"`.
 */
export async function confirmLeave(
  dirty: boolean,
  ask: () => Promise<LeaveChoice>,
  save: () => Promise<boolean>,
): Promise<false | "kept" | "discarded"> {
  if (!dirty) return "kept";
  const choice = await ask();
  if (choice === "cancel") return false;
  if (choice === "discard") return "discarded";
  return (await save()) ? "kept" : false;
}
