import { decryptSecret, encryptSecret, parseEncryptionKey } from "@defe2end/shared/server";

let key: Buffer | undefined;

/** `DEFE2END_ENCRYPTION_KEY`, parsed once. Startup has already checked it against the database. */
export function getEncryptionKey(): Buffer {
  return (key ??= parseEncryptionKey(process.env.DEFE2END_ENCRYPTION_KEY));
}

export function encrypt(plaintext: string): string {
  return encryptSecret(plaintext, getEncryptionKey());
}

export function decrypt(ciphertext: string): string {
  return decryptSecret(ciphertext, getEncryptionKey());
}
