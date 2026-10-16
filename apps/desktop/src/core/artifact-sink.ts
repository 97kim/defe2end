// Runner files go to `PUT /api/desktop/runs/{id}/artifacts/{kind}/{attempt}/{key}` (stage 4 contract section 4.3).
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { ARTIFACT_CONTENT_TYPES, ArtifactLimitError, DESKTOP_HEADERS, artifactRefSchema, RUN_LIMITS, type ArtifactMeta, type ArtifactRef, type ArtifactSink, type ArtifactWriter } from "@defe2end/shared";
import { readBody, type DesktopApi } from "./api-client.js";

/** One screenshot may not exceed this; everything else counts toward the run total only. */
export const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;

/** The server's key for a runner file: `step-{index}`, `main`/`popup-N`, `trace`, `log` (a step's log: `step-{index}`). */
export function artifactKey(meta: ArtifactMeta): string {
  switch (meta.kind) {
    case "screenshot":
    case "dom_summary":
      return `step-${meta.stepIndex ?? 0}`;
    case "video": {
      // The runner names the main page's video "video" (or "video-1" when popups were recorded too).
      const n = /^video-(\d+)$/.exec(meta.name);
      return n && Number(n[1]) > 1 ? `popup-${Number(n[1]) - 1}` : "main";
    }
    case "log":
      // A step's browser log gets a key of its own; the run-wide log stays one file.
      return meta.stepIndex === undefined ? "log" : `step-${meta.stepIndex}`;
    default:
      return meta.kind;
  }
}

export class OwnershipLostError extends Error {
  constructor(status: number) {
    super(`The server no longer accepts writes for this run (HTTP ${status})`);
    this.name = "OwnershipLostError";
  }
}

export interface UploadSinkOptions {
  api: Pick<DesktopApi, "request">;
  runId: string;
  claimToken: string;
  /** 404 or `409 lease_lost`: the executor stops the run. */
  onOwnershipLost(): void;
  tempRoot?: string;
}

/**
 * Spools each file to a temp file (the upload needs `Content-Length`), then streams it. 413 → the run's
 * total is over the limit → `ArtifactLimitError`, which the runner turns into `error(artifact_limit)`.
 */
export function uploadSink(opts: UploadSinkOptions): ArtifactSink {
  return {
    async open(meta: ArtifactMeta): Promise<ArtifactWriter> {
      const dir = await mkdtemp(path.join(opts.tempRoot ?? tmpdir(), "defe2end-artifact-"));
      const file = path.join(dir, "data");
      const handle = await open(file, "w", 0o600);
      let size = 0;
      const cleanup = async () => {
        await handle.close().catch(() => {});
        await rm(dir, { recursive: true, force: true });
      };
      return {
        async write(chunk) {
          size += chunk.byteLength;
          if (meta.kind === "screenshot" && size > SCREENSHOT_MAX_BYTES) throw new ArtifactLimitError(SCREENSHOT_MAX_BYTES);
          await handle.write(chunk);
        },
        async abort() {
          await cleanup();
        },
        async complete(): Promise<ArtifactRef> {
          try {
            await handle.close();
            const { size: length } = await stat(file);
            const key = artifactKey(meta);
            const attempt = meta.attempt ?? 1;
            const res = await opts.api.request(`/api/desktop/runs/${encodeURIComponent(opts.runId)}/artifacts/${meta.kind}/${attempt}/${key}`, {
              method: "PUT",
              headers: { "Content-Type": ARTIFACT_CONTENT_TYPES[meta.kind], "Content-Length": String(length), [DESKTOP_HEADERS.claimToken]: opts.claimToken },
              body: () => Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
              timeoutMs: 10 * 60_000,
            });
            const body = await readBody(res);
            if (res.status === 413) throw new ArtifactLimitError(RUN_LIMITS.runArtifactBytes);
            if (res.status === 404 || (res.status === 409 && (body as { code?: unknown } | null)?.code === "lease_lost")) {
              opts.onOwnershipLost();
              throw new OwnershipLostError(res.status);
            }
            if (!res.ok) throw new Error(`Artifact upload failed: HTTP ${res.status}`);
            const ref = artifactRefSchema.safeParse(body);
            if (ref.success) return ref.data;
            return {
              id: `${meta.kind}/${attempt}/${key}`,
              kind: meta.kind,
              attempt,
              ...(meta.stepIndex === undefined ? {} : { stepIndex: meta.stepIndex }),
              name: meta.name,
              contentType: ARTIFACT_CONTENT_TYPES[meta.kind],
              sizeBytes: length,
            };
          } finally {
            await cleanup();
          }
        },
      };
    },
  };
}
