// Variable values for a run (variables contract section 3). Shared variables use the environment's value;
// personal ones only the requester's own value — never the shared one, never anyone else's. One function for
// the worker's server runs and the desktop `run` message, so both decide the same way.
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

const VARIABLE_REF = /\{\{([A-Za-z0-9_]+)\}\}/g;
/** Step fields that are never substituted (labels and identity). */
const NOT_SUBSTITUTED = new Set(["id", "name", "action"]);

/** `{{KEY}}` keys the steps use in substituted fields (url, selector, value, expected, …). */
export function referencedVariableKeys(steps: unknown): string[] {
  const keys = new Set<string>();
  const walk = (node: unknown, field?: string) => {
    if (typeof node === "string") {
      if (field && NOT_SUBSTITUTED.has(field)) return;
      for (const m of node.matchAll(VARIABLE_REF)) keys.add(m[1]!);
    } else if (Array.isArray(node)) node.forEach((n) => walk(n, field));
    else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, k);
  };
  walk(steps);
  return [...keys].sort();
}

/**
 * Whose own values and login session a run uses (stage 5 contract section 1.1): the requester, or the
 * schedule's or bot token's own. Same shape as `ValueSubject` in @defe2end/shared. Never falls back.
 */
export type ValueSubject = { kind: "user"; userId: string } | { kind: "schedule"; scheduleId: string } | { kind: "bot"; botTokenId: string };

/** The subject of a stored run: its schedule or bot token if unattended, else its requester (null: none). */
export function subjectOfRun(run: { requestedById: string | null; scheduleId?: string | null; botTokenId?: string | null }): ValueSubject | null {
  if (run.scheduleId) return { kind: "schedule", scheduleId: run.scheduleId };
  if (run.botTokenId) return { kind: "bot", botTokenId: run.botTokenId };
  return run.requestedById ? { kind: "user", userId: run.requestedById } : null;
}

type OwnValue = { value: string | null; valueEncrypted: string | null };

/** The subject's own values of these personal variables, by variable id. */
async function ownValues(db: Db, subject: ValueSubject | null, variableIds: string[]): Promise<Map<string, OwnValue>> {
  if (!subject || variableIds.length === 0) return new Map();
  const select = { variableId: true, value: true, valueEncrypted: true } as const;
  const rows =
    subject.kind === "user"
      ? await db.personalVariableValue.findMany({ where: { userId: subject.userId, variableId: { in: variableIds } }, select })
      : subject.kind === "schedule"
        ? await db.scheduleVariableValue.findMany({ where: { scheduleId: subject.scheduleId, variableId: { in: variableIds } }, select })
        : await db.botVariableValue.findMany({ where: { botTokenId: subject.botTokenId, variableId: { in: variableIds } }, select });
  return new Map(rows.map((r) => [r.variableId, r]));
}

/**
 * Personal variables the steps reference that the subject has no own value for (all of them when there is no
 * subject). Empty = the run may be created / started.
 */
export async function missingPersonalVariables(db: Db, input: { environmentId: string; subject: ValueSubject | null; steps: unknown }): Promise<string[]> {
  const keys = referencedVariableKeys(input.steps);
  if (keys.length === 0) return [];
  const personal = await db.variable.findMany({ where: { environmentId: input.environmentId, scope: "personal", key: { in: keys } }, select: { id: true, key: true } });
  const own = await ownValues(db, input.subject, personal.map((v) => v.id));
  return personal.filter((v) => !own.has(v.id)).map((v) => v.key);
}

export type ResolvedVariables = Record<string, { value: string; secret: boolean }>;

/**
 * Values for a run starting now: shared ones from the environment, personal ones the subject's own. `missing`:
 * personal variables the steps use without one (the run ends `error(variable_missing)`). Memory only.
 */
export async function resolveRunVariables(
  db: Db,
  input: { workspaceId: string; environmentId: string | null; subject: ValueSubject | null; steps: unknown },
  decrypt: (ciphertext: string) => string,
): Promise<{ ok: true; variables: ResolvedVariables } | { ok: false; missing: string[] }> {
  if (!input.environmentId) return { ok: true, variables: {} };
  const missing = await missingPersonalVariables(db, { environmentId: input.environmentId, subject: input.subject, steps: input.steps });
  if (missing.length > 0) return { ok: false, missing };
  const rows = await db.variable.findMany({ where: { environmentId: input.environmentId, workspaceId: input.workspaceId } });
  const own = await ownValues(db, input.subject, rows.filter((v) => v.scope === "personal").map((v) => v.id));
  const variables: ResolvedVariables = {};
  for (const v of rows) {
    // Personal: the subject's own value only; not referenced and not set → left out rather than any fallback.
    const source = v.scope === "personal" ? own.get(v.id) : v;
    if (!source) continue;
    variables[v.key] = v.isSecret ? { value: source.valueEncrypted ? decrypt(source.valueEncrypted) : "", secret: true } : { value: source.value ?? "", secret: false };
  }
  return { ok: true, variables };
}

/** The subject's own unexpired login session of an environment (null: none — never someone else's). */
export async function subjectAuthSession(db: Db, environmentId: string, subject: ValueSubject | null) {
  if (!subject) return null;
  const where =
    subject.kind === "user"
      ? { environmentId_userId: { environmentId, userId: subject.userId } }
      : subject.kind === "schedule"
        ? { environmentId_scheduleId: { environmentId, scheduleId: subject.scheduleId } }
        : { environmentId_botTokenId: { environmentId, botTokenId: subject.botTokenId } };
  const session = await db.authSession.findUnique({ where, select: { id: true, encryptedState: true, expiresAt: true } });
  return session && session.expiresAt > new Date() ? session : null;
}

/**
 * Own-value lifetime (variables contract section 1, stage 5 section 2): a scope or secret-flag change drops
 * the schedules' and bot tokens' own values of the variable, like people's.
 */
export async function dropUnattendedValues(db: Db, variableId: string): Promise<void> {
  await db.scheduleVariableValue.deleteMany({ where: { variableId } });
  await db.botVariableValue.deleteMany({ where: { variableId } });
}

export const VARIABLE_MISSING_MESSAGE = "A personal variable this run uses has no value for whoever started it (person, schedule or bot token).";

/**
 * A variable's definition read under its row lock (`FOR UPDATE`). Writers of own values (bot, schedule) call
 * this first in their transaction: a scope or secret-flag change updates the same row, so the two serialise and
 * the value is stored (encrypted or not) for the definition that is current, or dropped by the change after it.
 */
export async function lockVariableDefinition(db: Db, workspaceId: string, variableId: string): Promise<{ id: string; key: string; isSecret: boolean; scope: "shared" | "personal" } | null> {
  const [row] = await db.$queryRaw<{ id: string; key: string; isSecret: boolean; scope: "shared" | "personal" }[]>`
    SELECT id, key, "isSecret", scope::text AS scope FROM "Variable" WHERE id = ${variableId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  return row ?? null;
}
