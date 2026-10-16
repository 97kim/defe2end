import { Prisma } from "@defe2end/db";
import type { Step } from "@defe2end/shared";
import { ApiError } from "./api";
import { getDb } from "./db";
import { assertMaskSelectors } from "./site-config";

type Db = ReturnType<typeof getDb> | Prisma.TransactionClient;

/** The worker team adds `Scenario.retryOnFailure`; until that lands the setting can't be stored. */
export const RETRY_SETTING_STORED = "retryOnFailure" in Prisma.ScenarioScalarFieldEnum;

export const scenarioInclude = {
  site: { select: { id: true, name: true } },
  tags: { select: { tag: { select: { id: true, name: true } } } },
  updatedBy: { select: { name: true } },
} satisfies Prisma.ScenarioInclude;

type ScenarioRow = Prisma.ScenarioGetPayload<{ include: typeof scenarioInclude }>;

export interface ScenarioSummary {
  id: string;
  name: string;
  site: { id: string; name: string };
  tags: { id: string; name: string }[];
  stepCount: number;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ScenarioDetail extends ScenarioSummary {
  description: string;
  steps: Step[];
  stepFormatVersion: number;
  updatedByName: string | null;
  /** Retry the whole run once after a failure (spec 4.3); null until the server has the setting. */
  retryOnFailure: boolean | null;
  /** Site selectors and automatic detection on (stage 7 section 5); field and step masks stay on regardless. */
  maskingEnabled: boolean;
}

function sortedTags(row: ScenarioRow) {
  return row.tags.map((t) => t.tag).sort((a, b) => a.name.localeCompare(b.name));
}

export function toSummary(row: ScenarioRow): ScenarioSummary {
  return {
    id: row.id,
    name: row.name,
    site: row.site,
    tags: sortedTags(row),
    stepCount: Array.isArray(row.steps) ? row.steps.length : 0,
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

export function toDetail(row: ScenarioRow): ScenarioDetail {
  return {
    ...toSummary(row),
    description: row.description,
    steps: row.steps as unknown as Step[],
    stepFormatVersion: row.stepFormatVersion,
    updatedByName: row.updatedBy?.name ?? null,
    retryOnFailure: RETRY_SETTING_STORED ? ((row as { retryOnFailure?: boolean }).retryOnFailure ?? true) : null,
    maskingEnabled: row.maskingEnabled,
  };
}

/** Every lookup by id is scoped to the checked workspace; another workspace's id is a plain 404. */
export async function findScenario(workspaceId: string, id: string, db: Db = getDb()) {
  const row = await db.scenario.findFirst({ where: { id, workspaceId }, include: scenarioInclude });
  if (!row) throw ApiError.notFound();
  return row;
}

export async function requireSite(workspaceId: string, siteId: string, db: Db = getDb()) {
  const site = await db.site.findFirst({ where: { id: siteId, workspaceId } });
  if (!site) throw ApiError.notFound();
  return site;
}

/** Workspace-scoped get-or-create; concurrent creators meet at the unique (workspaceId, name). */
export async function upsertTag(workspaceId: string, name: string, db: Db = getDb()) {
  return db.tag.upsert({
    where: { workspaceId_name: { workspaceId, name } },
    create: { workspaceId, name },
    update: {},
  });
}

export async function setScenarioTags(workspaceId: string, scenarioId: string, names: string[], db: Db) {
  for (const name of new Set(names)) {
    const tag = await upsertTag(workspaceId, name, db);
    await db.scenarioTag.upsert({
      where: { scenarioId_tagId: { scenarioId, tagId: tag.id } },
      create: { workspaceId, scenarioId, tagId: tag.id },
      update: {},
    });
  }
}

/** Step `mask` lists are checked on save like the site's selectors (stage 7 contract section 5). */
export function assertStepMasks(steps: readonly Step[]): void {
  for (const [i, step] of steps.entries()) if (step.mask) assertMaskSelectors(step.mask, `Step ${i + 1} mask selector`);
}
