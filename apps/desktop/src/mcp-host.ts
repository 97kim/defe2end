// The MCP token's secure store (Electron `safeStorage`) for `core/mcp-host.ts`.
import { readFile, rm, writeFile } from "node:fs/promises";
import { safeStorage } from "electron";
import type { McpTokenRecord, McpTokenStore, McpTokenStoreKey } from "./core/mcp-relay.js";

/** MCP token in the OS secure store, keyed by server origin + user + device. */
export function safeStorageMcpTokenStore(file: string): McpTokenStore {
  const same = (a: McpTokenStoreKey, b: McpTokenStoreKey) => a.origin === b.origin && a.userId === b.userId && a.deviceId === b.deviceId;
  return {
    async load(key) {
      if (!safeStorage.isEncryptionAvailable()) return null;
      try {
        const saved = JSON.parse(safeStorage.decryptString(await readFile(file))) as McpTokenRecord & { key: McpTokenStoreKey };
        return same(saved.key, key) ? { token: saved.token, expiresAt: saved.expiresAt, deviceId: saved.deviceId } : null;
      } catch {
        return null;
      }
    },
    async save(key, record) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("No secure store");
      await writeFile(file, safeStorage.encryptString(JSON.stringify({ ...record, key })), { mode: 0o600 });
    },
    clear: () => rm(file, { force: true }),
  };
}
