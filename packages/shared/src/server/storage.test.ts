import { mkdtemp, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { artifactKey, attachmentKey, LocalStorage, StorageFullError, StorageKeyError } from "./index.js";

async function storage() {
  const root = await mkdtemp(join(tmpdir(), "defe2end-storage-"));
  return { root, store: new LocalStorage(root) };
}

async function* chunks(...parts: string[]) {
  for (const p of parts) yield new TextEncoder().encode(p);
}

describe("LocalStorage", () => {
  it("writes through a temp file and reads back", async () => {
    const { root, store } = await storage();
    const key = artifactKey("ws1", "run1", "png");
    expect(await store.put(key, chunks("ab", "cd"))).toEqual({ sizeBytes: 4 });
    expect(await text(await store.get(key))).toBe("abcd");
    expect(await store.stat(key)).toEqual({ sizeBytes: 4 });
    expect(await readdir(join(root, ".tmp"))).toEqual([]);
    await store.delete(key);
    expect(await store.stat(key)).toBeNull();
  });

  it("refuses keys that are not server-shaped or leave the root", async () => {
    const { store } = await storage();
    for (const key of ["../x.png", "a/../../x", "/etc/passwd", "a//b", ".tmp/x", "a/b.png/../c", "A b.png"]) {
      await expect(store.put(key, chunks("x"))).rejects.toBeInstanceOf(StorageKeyError);
    }
  });

  it("refuses a symlinked directory or file pointing outside", async () => {
    const { root, store } = await storage();
    const outside = await mkdtemp(join(tmpdir(), "defe2end-outside-"));
    await writeFile(join(outside, "secret.txt"), "nope");
    await symlink(outside, join(root, "escape"));
    await expect(store.put("escape/x.png", chunks("x"))).rejects.toBeInstanceOf(StorageKeyError);
    await expect(store.get("escape/secret.txt")).rejects.toBeInstanceOf(StorageKeyError);
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    await expect(store.get("link.txt")).rejects.toThrow();
  });

  it("does not overwrite an existing key and leaves no temp file behind", async () => {
    const { root, store } = await storage();
    await store.put("a/b.png", chunks("1"));
    await expect(store.put("a/b.png", chunks("2"))).rejects.toBeInstanceOf(StorageKeyError);
    expect(await text(await store.get("a/b.png"))).toBe("1");
    expect(await readdir(join(root, ".tmp"))).toEqual([]);
  });

  it("cleans temp files left by a crash", async () => {
    const { root, store } = await storage();
    await store.freeBytes();
    const stale = join(root, ".tmp", "stale");
    await writeFile(stale, "x");
    await utimes(stale, new Date(0), new Date(0));
    await writeFile(join(root, ".tmp", "fresh"), "x");
    expect(await store.cleanupTemp(60_000)).toBe(1);
    expect(await readdir(join(root, ".tmp"))).toEqual(["fresh"]);
  });

  it("lists stored files under a prefix, never following symlinks or leaving the root", async () => {
    const { root, store } = await storage();
    const a = artifactKey("ws1", "run1", "png");
    const b = attachmentKey("ws1");
    await store.put(a, chunks("a"));
    await store.put(b, chunks("b"));
    await store.put(artifactKey("ws2", "run2", "png"), chunks("c"));
    const outside = await mkdtemp(join(tmpdir(), "defe2end-outside-"));
    await writeFile(join(outside, "secret.png"), "x");
    await symlink(outside, join(root, "workspaces", "ws1", "linked"));
    const list = async (prefix: string) => {
      const keys = [];
      for await (const f of store.list(prefix)) keys.push(f.key);
      return keys.sort();
    };
    expect(await list("workspaces/ws1/")).toEqual([a, b].sort());
    expect(await list("workspaces/none/")).toEqual([]);
    for (const bad of ["../", "workspaces/../", ".tmp/", "workspaces", "/etc/"]) await expect(list(bad)).rejects.toBeInstanceOf(StorageKeyError);
    await expect(list("workspaces/ws1/linked/")).rejects.toBeInstanceOf(StorageKeyError);
  });

  it("reports a full volume as StorageFullError and leaves no temp file", async () => {
    const { root, store } = await storage();
    async function* enospc() {
      yield new TextEncoder().encode("x");
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    await expect(store.put(artifactKey("ws", "run", "png"), enospc())).rejects.toBeInstanceOf(StorageFullError);
    expect(await readdir(join(root, ".tmp"))).toEqual([]);
  });
});
