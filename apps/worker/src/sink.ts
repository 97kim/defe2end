import { once } from "node:events";
import { PassThrough } from "node:stream";
import { registerArtifact, type PrismaClient } from "@defe2end/db";
import { ARTIFACT_CONTENT_TYPES, ArtifactLimitError, type ArtifactKind, type ArtifactSink } from "@defe2end/shared";
import { artifactKey, StorageFullError, type StorageDriver } from "@defe2end/shared/server";

const EXTENSIONS: Record<ArtifactKind, string> = { screenshot: "png", video: "webm", trace: "zip", log: "txt", dom_summary: "txt" };

/** The volume filled up under a run: collection stops and the run ends `error(artifact_limit)` like an over-limit run. */
export class StorageFullLimitError extends ArtifactLimitError {
  constructor() {
    super(0);
    this.message = "The storage volume is full; artifact collection stopped";
  }
}

const limitError = (err: unknown) => (err instanceof StorageFullError ? new StorageFullLimitError() : err);

export class LeaseLostError extends Error {
  constructor() {
    super("The run's lease was lost; the file was discarded");
  }
}

/**
 * Streams runner files into storage (temp file → atomic move, server-made key), then registers them under
 * the ownership check. A file whose registration is refused or fails is deleted again.
 */
export function storageSink(opts: {
  db: PrismaClient;
  storage: StorageDriver;
  run: { id: string; workspaceId: string; claimToken: string };
  /** The whole-run attempt in progress; read when a file is registered. Defaults to 1. */
  attempt?: () => number;
  limitBytes: number;
  onLeaseLost(): void;
}): ArtifactSink {
  let total = 0;
  return {
    async open(meta) {
      const key = artifactKey(opts.run.workspaceId, opts.run.id, EXTENSIONS[meta.kind]);
      const body = new PassThrough();
      // put() may not be piping yet when the body is dropped; the error still reaches it through `destroyed`.
      body.on("error", () => {});
      const stored = opts.storage.put(key, body);
      stored.catch(() => {}); // Awaited in complete()/abort(); this only silences the early rejection.
      const drop = async (reason: Error) => {
        body.destroy(reason);
        await stored.catch(() => {});
      };
      return {
        async write(chunk) {
          total += chunk.byteLength;
          if (total > opts.limitBytes) {
            const err = new ArtifactLimitError(opts.limitBytes);
            await drop(err);
            throw err;
          }
          try {
            if (!body.write(chunk)) await once(body, "drain");
          } catch (err) {
            // The write side failed (e.g. ENOSPC): report what put() saw.
            throw limitError(await stored.then(() => err, (e: unknown) => e));
          }
        },
        async complete() {
          body.end();
          const { sizeBytes } = await stored.catch((err: unknown) => Promise.reject(limitError(err)));
          const contentType = ARTIFACT_CONTENT_TYPES[meta.kind];
          let id: string | null;
          try {
            id = await registerArtifact(opts.db, opts.run.id, opts.run.claimToken, {
              workspaceId: opts.run.workspaceId,
              kind: meta.kind,
              attempt: meta.attempt ?? opts.attempt?.() ?? 1,
              stepIndex: meta.stepIndex,
              name: meta.name,
              storageKey: key,
              contentType,
              sizeBytes,
            });
          } catch (err) {
            await opts.storage.delete(key);
            throw err;
          }
          if (!id) {
            await opts.storage.delete(key);
            opts.onLeaseLost();
            throw new LeaseLostError();
          }
          return { id, kind: meta.kind, stepIndex: meta.stepIndex, attempt: meta.attempt ?? opts.attempt?.() ?? 1, name: meta.name, contentType, sizeBytes };
        },
        abort: (reason) => drop(new Error(reason)),
      };
    },
  };
}
