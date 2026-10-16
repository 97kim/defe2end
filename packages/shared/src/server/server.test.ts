import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createKeyCheck,
  decryptSecret,
  encryptSecret,
  generateLinkToken,
  hashLinkToken,
  parseEncryptionKey,
  verifyKeyCheck,
  verifyLinkToken,
} from "./index.js";

describe("link tokens", () => {
  it("are 32 random bytes in base64url", () => {
    const token = generateLinkToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateLinkToken()).not.toBe(token);
  });

  it("verify only against their own hash", () => {
    const token = generateLinkToken();
    const hash = hashLinkToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyLinkToken(token, hash)).toBe(true);
    expect(verifyLinkToken(generateLinkToken(), hash)).toBe(false);
    expect(verifyLinkToken(token, "")).toBe(false);
  });
});

describe("encryption", () => {
  const key = randomBytes(32);

  it("round-trips in the v1 format", () => {
    const ciphertext = encryptSecret("p4ss wörd", key);
    expect(ciphertext.split(":")).toHaveLength(4);
    expect(ciphertext.startsWith("v1:")).toBe(true);
    expect(ciphertext).not.toContain("p4ss");
    expect(decryptSecret(ciphertext, key)).toBe("p4ss wörd");
    expect(encryptSecret("p4ss wörd", key)).not.toBe(ciphertext);
  });

  it("rejects a wrong key, tampering and unknown versions", () => {
    const ciphertext = encryptSecret("secret", key);
    expect(() => decryptSecret(ciphertext, randomBytes(32))).toThrow();
    const [v, iv, tag, data] = ciphertext.split(":");
    const flipped = Buffer.from(data!, "base64url");
    flipped[0]! ^= 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64url")].join(":"), key)).toThrow();
    expect(() => decryptSecret(ciphertext.replace(/^v1/, "v2"), key)).toThrow("Unsupported");
  });

  it("parses the env key", () => {
    expect(parseEncryptionKey(key.toString("base64"))).toEqual(key);
    expect(() => parseEncryptionKey(undefined)).toThrow("not set");
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow("32 bytes");
  });

  it("key check detects a changed key", () => {
    const check = createKeyCheck(key);
    expect(verifyKeyCheck(check, key)).toBe(true);
    expect(verifyKeyCheck(check, randomBytes(32))).toBe(false);
    expect(verifyKeyCheck("garbage", key)).toBe(false);
  });
});
