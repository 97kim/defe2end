import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * File storage for artifacts and attachments (contract section 7). Keys are made by the server
 * (`artifactKey`), never from user file names. Stage 3 ships the local volume; S3-compatible storage
 * implements the same interface later.
 */
export interface StorageDriver {
  /** Writes to a temporary file, then moves it into place atomically. Overwrites nothing: an existing key fails. */
  put(key: string, body: AsyncIterable<Uint8Array> | Readable): Promise<{ sizeBytes: number }>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  /** Stored files under `prefix` (a key prefix ending at a `/`), for the cleanup of unregistered files. */
  list(prefix: string): AsyncIterable<{ key: string; modifiedAt: Date }>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*(\.[a-z0-9]{1,8})?$/;
const TEMP_DIR = ".tmp";

export class StorageKeyError extends Error {}

/** The volume ran out of space (ENOSPC) while a file was written; nothing was stored. */
export class StorageFullError extends Error {
  constructor() {
    super("The storage volume is full");
  }
}

/** `workspaces/<ws>/runs/<run>/<random>.<ext>`: only server-generated ids, nothing the user typed. */
export function artifactKey(workspaceId: string, runId: string, extension: string): string {
  return `workspaces/${workspaceId}/runs/${runId}/${randomUUID()}.${extension}`.toLowerCase();
}

/** `workspaces/<ws>/attachments/<random>.bin`: the user's file name is kept in the database only. */
export function attachmentKey(workspaceId: string): string {
  return `workspaces/${workspaceId}/attachments/${randomUUID()}.bin`.toLowerCase();
}

/** Local volume shared by web and worker. Refuses keys that leave the root, including through symlinks. */
export class LocalStorage implements StorageDriver {
  private realRoot?: Promise<string>;

  constructor(readonly root: string) {}

  private async rootPath(): Promise<string> {
    return (this.realRoot ??= mkdir(join(this.root, TEMP_DIR), { recursive: true }).then(() => realpath(this.root)));
  }

  /** Resolves a key to a path whose real parent directory is inside the root. */
  private async resolve(key: string, createParent: boolean): Promise<string> {
    if (!KEY_PATTERN.test(key) || key.startsWith(`${TEMP_DIR}/`)) throw new StorageKeyError(`Invalid storage key: ${key}`);
    const root = await this.rootPath();
    const path = join(root, key);
    if (createParent) await mkdir(dirname(path), { recursive: true });
    const parent = await realpath(dirname(path));
    if (parent !== root && !parent.startsWith(root + sep)) throw new StorageKeyError(`Storage key leaves the root: ${key}`);
    return path;
  }

  async put(key: string, body: AsyncIterable<Uint8Array> | Readable): Promise<{ sizeBytes: number }> {
    const path = await this.resolve(key, true);
    const temp = join(await this.rootPath(), TEMP_DIR, randomUUID());
    const file = createWriteStream(temp, { flags: "wx", mode: 0o640 });
    try {
      await pipeline(body, file);
      const { size } = await stat(temp);
      // rename() would replace an existing file; keys are unique, so treat one as a bug.
      if (await this.stat(key)) throw new StorageKeyError(`Storage key already exists: ${key}`);
      await rename(temp, path);
      return { sizeBytes: size };
    } catch (err) {
      // A source that fails early can beat the file's open: wait until it is closed, or rm() runs first.
      if (!file.closed) await once(file, "close").catch(() => {});
      await rm(temp, { force: true });
      if ((err as NodeJS.ErrnoException).code === "ENOSPC") throw new StorageFullError();
      throw err;
    }
  }

  async get(key: string): Promise<Readable> {
    const path = await this.resolve(key, false);
    // The file itself must not be a symlink either. O_NOFOLLOW also closes the race on POSIX; Windows has no
    // O_NOFOLLOW (the constant is undefined there), so the lstat check is what refuses it.
    if ((await lstat(path)).isSymbolicLink()) throw new StorageKeyError(`Storage key is a symlink: ${key}`);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return handle.createReadStream();
  }

  async delete(key: string): Promise<void> {
    await rm(await this.resolve(key, false), { force: true });
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const info = await stat(await this.resolve(key, false));
      return info.isFile() ? { sizeBytes: info.size } : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async *list(prefix: string): AsyncIterable<{ key: string; modifiedAt: Date }> {
    if (!/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\/$/.test(prefix) || prefix.startsWith(`${TEMP_DIR}/`)) {
      throw new StorageKeyError(`Invalid storage prefix: ${prefix}`);
    }
    const root = await this.rootPath();
    // join() turns the prefix's "/" into the platform separator, trailing one included.
    const start = join(root, prefix.replace(/\/$/, ""));
    const real = await realpath(start).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (real === null) return;
    if (real !== start || !real.startsWith(root + sep)) throw new StorageKeyError(`Storage prefix leaves the root: ${prefix}`);
    // Walks real directories only: a symlink inside is neither followed nor listed.
    const walk = async function* (dir: string, keyPrefix: string): AsyncIterable<{ key: string; modifiedAt: Date }> {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name);
        const key = `${keyPrefix}${entry.name}`;
        if (entry.isDirectory()) yield* walk(path, `${key}/`);
        else if (entry.isFile() && KEY_PATTERN.test(key)) {
          const info = await stat(path).catch(() => null);
          if (info) yield { key, modifiedAt: info.mtime };
        }
      }
    };
    yield* walk(real, prefix);
  }

  /** Free space on the volume, for the `MIN_FREE_DISK_MB` check. */
  async freeBytes(): Promise<number> {
    const info = await statfs(await this.rootPath());
    return info.bavail * info.bsize;
  }

  /** Removes temporary files left by a crash. Call at worker start; `olderThanMs` spares writes in progress elsewhere. */
  async cleanupTemp(olderThanMs: number): Promise<number> {
    const dir = join(await this.rootPath(), TEMP_DIR);
    let removed = 0;
    for (const name of await readdir(dir)) {
      const file = join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info && Date.now() - info.mtimeMs > olderThanMs) {
        await rm(file, { force: true });
        removed++;
      }
    }
    return removed;
  }
}
