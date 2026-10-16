import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const KEY_CHECK_PLAINTEXT = "defe2end-encryption-key-check";

/** Parses `DEFE2END_ENCRYPTION_KEY` (base64 of 32 bytes, e.g. `openssl rand -base64 32`). */
export function parseEncryptionKey(base64: string | undefined): Buffer {
  if (!base64) throw new Error("DEFE2END_ENCRYPTION_KEY is not set (generate one with `openssl rand -base64 32`)");
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("DEFE2END_ENCRYPTION_KEY must be base64 of exactly 32 bytes");
  return key;
}

/** AES-256-GCM. Output: `v1:<iv>:<tag>:<data>`, each part base64url. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, data].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(":");
}

/** Throws if the format is unknown or the key/ciphertext does not authenticate. */
export function decryptSecret(ciphertext: string, key: Buffer): string {
  const [version, iv, tag, data, ...rest] = ciphertext.split(":");
  if (version !== VERSION || iv === undefined || tag === undefined || data === undefined || rest.length > 0) {
    throw new Error("Unsupported ciphertext format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** Value stored in `InstanceSetting.encryptionKeyCheck` on first start. */
export function createKeyCheck(key: Buffer): string {
  return encryptSecret(KEY_CHECK_PLAINTEXT, key);
}

/** True when `key` is the key that produced `check`. */
export function verifyKeyCheck(check: string, key: Buffer): boolean {
  try {
    return decryptSecret(check, key) === KEY_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}
