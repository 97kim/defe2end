import type { Readable } from "node:stream";
import type { PrismaClient } from "@defe2end/db";
import { ArtifactLimitError } from "@defe2end/shared";
import { StorageFullError, type StorageDriver } from "@defe2end/shared/server";
import { describe, expect, it, vi } from "vitest";
import { storageSink } from "./sink.js";

/** A storage whose volume fills up: put() drains the body and fails with ENOSPC like LocalStorage does. */
function fullStorage(): StorageDriver {
  return {
    async put(_key, body) {
      for await (const _ of body as Readable) throw new StorageFullError();
      throw new StorageFullError();
    },
    get: vi.fn(),
    delete: vi.fn(async () => {}),
    stat: vi.fn(async () => null),
    list: vi.fn(),
  };
}

const run = { id: "r1", workspaceId: "w1", claimToken: "t" };

describe("storageSink", () => {
  it("a full volume ends collection as an artifact limit, registering nothing", async () => {
    const db = { $transaction: vi.fn() } as unknown as PrismaClient;
    const sink = storageSink({ db, storage: fullStorage(), run, limitBytes: 1_000_000, onLeaseLost: vi.fn() });
    const writer = await sink.open({ kind: "screenshot", name: "s" });
    const done = (async () => {
      await writer.write(new Uint8Array(10));
      return writer.complete();
    })();
    await expect(done).rejects.toBeInstanceOf(ArtifactLimitError);
    await expect(done).rejects.toThrow(/storage volume is full/);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("the per-run total counts every file and stops at the limit", async () => {
    const stored: string[] = [];
    const storage: StorageDriver = {
      async put(key, body) {
        let size = 0;
        for await (const chunk of body as Readable) size += (chunk as Buffer).length;
        stored.push(key);
        return { sizeBytes: size };
      },
      get: vi.fn(),
      delete: vi.fn(async () => {}),
      stat: vi.fn(async () => null),
      list: vi.fn(),
    };
    const sink = storageSink({ db: {} as PrismaClient, storage, run, limitBytes: 100, onLeaseLost: vi.fn() });
    const first = await sink.open({ kind: "log", name: "a" });
    await first.write(new Uint8Array(60));
    const second = await sink.open({ kind: "log", name: "b" });
    await expect(second.write(new Uint8Array(60))).rejects.toBeInstanceOf(ArtifactLimitError);
    expect(stored).toEqual([]); // the over-limit file never reached its key
    await first.abort("test done");
  });
});
