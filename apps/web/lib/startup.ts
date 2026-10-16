import { assertNotRestoring, type PrismaClient } from "@defe2end/db";
import { createKeyCheck, generateLinkToken, hashLinkToken, parseEncryptionKey, verifyKeyCheck } from "@defe2end/shared/server";

/**
 * Refuses to run with a different encryption key than the one the data was written with.
 * Records the key check on first start.
 */
export async function checkEncryptionKey(db: PrismaClient, keyBase64: string | undefined): Promise<void> {
  const key = parseEncryptionKey(keyBase64);
  const setting = await db.instanceSetting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  if (setting.encryptionKeyCheck === null) {
    // Conditional so two instances starting at once can't both write different checks.
    await db.instanceSetting.updateMany({
      where: { id: 1, encryptionKeyCheck: null },
      data: { encryptionKeyCheck: createKeyCheck(key) },
    });
    const current = await db.instanceSetting.findUniqueOrThrow({ where: { id: 1 } });
    if (!verifyKeyCheck(current.encryptionKeyCheck!, key)) throw new EncryptionKeyMismatch();
    return;
  }
  if (!verifyKeyCheck(setting.encryptionKeyCheck, key)) throw new EncryptionKeyMismatch();
}

export class EncryptionKeyMismatch extends Error {
  constructor() {
    super(
      "DEFE2END_ENCRYPTION_KEY does not match the key this database was set up with. " +
        "Restore the original key; starting with a different one would make stored secrets unreadable.",
    );
  }
}

/**
 * While no instance admin exists, issues a fresh install token (only its hash is stored)
 * and returns it so the caller prints it once. Returns null once setup is done.
 */
export async function issueInstallToken(db: PrismaClient): Promise<string | null> {
  if (await db.user.count({ where: { isInstanceAdmin: true } })) return null;
  const token = generateLinkToken();
  await db.instanceSetting.upsert({
    where: { id: 1 },
    create: { id: 1, installTokenHash: hashLinkToken(token) },
    update: { installTokenHash: hashLinkToken(token), installTokenUsedAt: null },
  });
  return token;
}

/** Runs once when the web server starts (instrumentation.ts). Exits the process on fatal config errors. */
export async function runStartup(db: PrismaClient): Promise<void> {
  try {
    if (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32) {
      throw new Error("BETTER_AUTH_SECRET must be set to at least 32 characters (e.g. `openssl rand -base64 32`)");
    }
    await assertNotRestoring(db);
    await checkEncryptionKey(db, process.env.DEFE2END_ENCRYPTION_KEY);
  } catch (err) {
    console.error(`defE2End cannot start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const token = await issueInstallToken(db);
  if (token) {
    const base = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
    console.log(
      [
        "",
        "No administrator yet. Finish setup with this one-time install token:",
        `  ${base}/setup#token=${token}`,
        "A new token is issued on every start until setup is done.",
        "",
      ].join("\n"),
    );
  }
}
