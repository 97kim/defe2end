// Bot tokens managed on the web by admins (stage 5 contract sections 1.1 and 7): create (raw token shown once,
// SHA-256 stored), list, revoke, the bot's own personal variable values and login session status.
import { lockVariableDefinition, type Prisma } from "@defe2end/db";
import { BOT_TOKEN_SCOPES, BOT_TOKEN_TTL_DAYS } from "@defe2end/shared";
import { z } from "zod";
import { generateBotToken } from "./api-v1";
import { ApiError } from "./api";
import { audit } from "./audit";
import { getDb } from "./db";
import { encrypt } from "./encryption";

export const createBotTokenSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(BOT_TOKEN_SCOPES)).min(1),
  expiresInDays: z.number().int().min(1).max(BOT_TOKEN_TTL_DAYS.max).default(BOT_TOKEN_TTL_DAYS.default),
});

export const botValueSchema = z.strictObject({ value: z.string().max(10_000) });

export interface BotTokenView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  createdByName: string | null;
}

const listSelect = { id: true, name: true, prefix: true, scopes: true, expiresAt: true, revokedAt: true, lastUsedAt: true, createdAt: true, createdBy: { select: { name: true } } } as const;
type ListRow = { id: string; name: string; prefix: string; scopes: string[]; expiresAt: Date; revokedAt: Date | null; lastUsedAt: Date | null; createdAt: Date; createdBy: { name: string } | null };

function toView(row: ListRow): BotTokenView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy?.name ?? null,
  };
}

export async function listBotTokens(workspaceId: string): Promise<BotTokenView[]> {
  const rows = await getDb().botToken.findMany({ where: { workspaceId }, orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }], select: listSelect });
  return rows.map(toView);
}

/** Returns the raw token once; only its hash is kept. */
export async function createBotToken(workspaceId: string, actorId: string, input: z.infer<typeof createBotTokenSchema>): Promise<{ token: string; item: BotTokenView }> {
  const { raw, tokenHash, prefix } = generateBotToken();
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
  const row = await getDb().$transaction(async (tx) => {
    const created = await tx.botToken.create({ data: { workspaceId, name: input.name, tokenHash, prefix, scopes: [...new Set(input.scopes)], expiresAt, createdById: actorId }, select: listSelect });
    await audit({ workspaceId, actorId, action: "botToken.create", targetType: "botToken", targetId: created.id, meta: { name: input.name, scopes: created.scopes, expiresAt: expiresAt.toISOString() } }, tx);
    return created;
  });
  return { token: raw, item: toView(row) };
}

async function findToken(workspaceId: string, tokenId: string) {
  const token = await getDb().botToken.findFirst({ where: { id: tokenId, workspaceId } });
  if (!token) throw ApiError.notFound();
  return token;
}

/** Immediately invalid; repeating is a no-op. */
export async function revokeBotToken(workspaceId: string, actorId: string, tokenId: string): Promise<void> {
  const token = await findToken(workspaceId, tokenId);
  await getDb().$transaction(async (tx) => {
    // Waits for a run creation holding the token row (`FOR SHARE`), so none commits after the revoke.
    const [row] = await tx.$queryRaw<{ revokedAt: Date | null }[]>`SELECT "revokedAt" FROM "BotToken" WHERE id = ${token.id} FOR UPDATE`;
    if (!row || row.revokedAt) return;
    await tx.botToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } });
    await audit({ workspaceId, actorId, action: "botToken.revoke", targetType: "botToken", targetId: token.id, meta: { name: token.name } }, tx);
  });
}

export interface BotDetail {
  token: BotTokenView;
  /** Personal variables of every environment; secret values are never returned. */
  values: { variableId: string; key: string; isSecret: boolean; environmentId: string; environmentName: string; siteName: string; hasValue: boolean; value: string | null }[];
  /** Environments that need a login session, and whether this bot has one. */
  sessions: { environmentId: string; environmentName: string; siteName: string; savedAt: string | null; expiresAt: string | null }[];
}

export async function getBotDetail(workspaceId: string, tokenId: string): Promise<BotDetail> {
  const db = getDb();
  const token = await db.botToken.findFirst({ where: { id: tokenId, workspaceId }, select: listSelect });
  if (!token) throw ApiError.notFound();
  const [variables, environments] = await Promise.all([
    db.variable.findMany({
      where: { workspaceId, scope: "personal" },
      orderBy: [{ environment: { site: { name: "asc" } } }, { environment: { name: "asc" } }, { key: "asc" }],
      select: { id: true, key: true, isSecret: true, environment: { select: { id: true, name: true, site: { select: { name: true } } } }, botValues: { where: { botTokenId: tokenId }, select: { value: true, valueEncrypted: true } } },
    }),
    db.environment.findMany({
      where: { workspaceId, useAuthSession: true },
      orderBy: [{ site: { name: "asc" } }, { name: "asc" }],
      select: { id: true, name: true, site: { select: { name: true } }, authSessions: { where: { botTokenId: tokenId }, select: { savedAt: true, expiresAt: true } } },
    }),
  ]);
  return {
    token: toView(token),
    values: variables.map((v) => {
      const own = v.botValues[0];
      return { variableId: v.id, key: v.key, isSecret: v.isSecret, environmentId: v.environment.id, environmentName: v.environment.name, siteName: v.environment.site.name, hasValue: own !== undefined, value: v.isSecret ? null : (own?.value ?? null) };
    }),
    sessions: environments.map((e) => {
      const s = e.authSessions[0];
      return { environmentId: e.id, environmentName: e.name, siteName: e.site.name, savedAt: s?.savedAt.toISOString() ?? null, expiresAt: s?.expiresAt.toISOString() ?? null };
    }),
  };
}

/** The variable's definition, re-read under its row lock so a scope or secret-flag change can't interleave. */
async function lockPersonalVariable(tx: Prisma.TransactionClient, workspaceId: string, variableId: string) {
  const variable = await lockVariableDefinition(tx, workspaceId, variableId);
  if (!variable) throw ApiError.notFound();
  if (variable.scope !== "personal") throw new ApiError("conflict", "This variable is shared; it has no bot values");
  return variable;
}

/** Sets the bot's own value of a personal variable; secrets are stored encrypted. Audited without the value. */
export async function setBotValue(workspaceId: string, actorId: string, tokenId: string, variableId: string, value: string): Promise<void> {
  const token = await findToken(workspaceId, tokenId);
  await getDb().$transaction(async (tx) => {
    const variable = await lockPersonalVariable(tx, workspaceId, variableId);
    if (variable.isSecret && value.length === 0) throw new ApiError("invalid_request", "A secret needs a value");
    const data = variable.isSecret ? { value: null, valueEncrypted: encrypt(value) } : { value, valueEncrypted: null };
    await tx.botVariableValue.upsert({ where: { botTokenId_variableId: { botTokenId: token.id, variableId: variable.id } }, create: { botTokenId: token.id, variableId: variable.id, ...data }, update: data });
    await audit({ workspaceId, actorId, action: "botToken.value.set", targetType: "botToken", targetId: token.id, meta: { key: variable.key, variableId: variable.id } }, tx);
  });
}

export async function deleteBotValue(workspaceId: string, actorId: string, tokenId: string, variableId: string): Promise<void> {
  const token = await findToken(workspaceId, tokenId);
  await getDb().$transaction(async (tx) => {
    const variable = await lockPersonalVariable(tx, workspaceId, variableId);
    await tx.botVariableValue.deleteMany({ where: { botTokenId: token.id, variableId: variable.id } });
    await audit({ workspaceId, actorId, action: "botToken.value.delete", targetType: "botToken", targetId: token.id, meta: { key: variable.key, variableId: variable.id } }, tx);
  });
}
