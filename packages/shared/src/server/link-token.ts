import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Link lifetimes (contract section 5). */
export const LINK_TOKEN_TTL_MS = {
  invite: 72 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
} as const;

/** 32 random bytes, base64url. Show it once; store only `hashLinkToken(token)`. */
export function generateLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex digest; this is what the database stores. */
export function hashLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time check of a presented token against a stored hash. */
export function verifyLinkToken(token: string, storedHash: string): boolean {
  const actual = Buffer.from(hashLinkToken(token), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
