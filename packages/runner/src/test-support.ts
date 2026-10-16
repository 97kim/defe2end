// Shared by the browser tests: a fixture server, an in-memory sink and a plan builder.
import { DEFAULT_DEVICE, type ArtifactRef, type ArtifactSink, type ExecutionPlan, type RunnerEvent, type Step } from "@defe2end/shared";
import { startFixtureServer, type FixtureServer } from "@defe2end/test-fixtures";
import { chromium } from "playwright";
import { afterAll, beforeAll, expect } from "vitest";
import { listMarkedBrowsers } from "./browser.js";
import { runPlanWith, type RunInternals, type RunPlanOptions } from "./run.js";

export const SANDBOX = process.env.CHROMIUM_SANDBOX !== "false";
export const SECRET = "hunter2-secret-value";

/** Starts the fixture server for the calling test file. */
export function useFixtures(): { readonly url: string; readonly port: number } {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixtureServer();
  });
  afterAll(() => server.close());
  return {
    get url() {
      return server.url;
    },
    get port() {
      return server.port;
    },
  };
}

export type StoredArtifact = ArtifactRef & { bytes: Buffer };

/** `failOpen` makes chosen opens throw (e.g. the first screenshot), as a broken storage would. */
export function memorySink(failOpen?: (meta: Parameters<ArtifactSink["open"]>[0]) => boolean) {
  const files: StoredArtifact[] = [];
  const sink: ArtifactSink = {
    async open(meta) {
      if (failOpen?.(meta)) throw new Error("storage is unavailable");
      const chunks: Uint8Array[] = [];
      return {
        write: async (chunk) => void chunks.push(chunk),
        complete: async () => {
          const bytes = Buffer.concat(chunks);
          const ref: ArtifactRef = { id: `a${files.length}`, kind: meta.kind, name: meta.name, contentType: "application/octet-stream", sizeBytes: bytes.length };
          if (meta.stepIndex !== undefined) ref.stepIndex = meta.stepIndex;
          files.push({ ...ref, bytes });
          return ref;
        },
        abort: async () => {},
      };
    },
  };
  return { sink, files };
}

export function makePlan(baseUrl: string, steps: Step[], extra: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    runId: `run-${Math.random().toString(36).slice(2)}`,
    baseUrl,
    steps,
    variables: {},
    device: DEFAULT_DEVICE,
    stepTimeoutMs: 5_000,
    network: { blockPrivateNetworks: false },
    capture: { video: false, traceOnFailure: false },
    ...extra,
  };
}

export async function execute(
  p: ExecutionPlan,
  opts: { signal?: AbortSignal; internals?: RunInternals; resolveAttachment?: RunPlanOptions["resolveAttachment"]; masking?: RunPlanOptions["masking"]; failOpen?: Parameters<typeof memorySink>[0] } = {},
) {
  const events: RunnerEvent[] = [];
  const { sink, files } = memorySink(opts.failOpen);
  const verdict = await runPlanWith(
    p,
    {
      sink,
      signal: opts.signal ?? new AbortController().signal,
      owner: String(process.pid),
      sandbox: SANDBOX,
      onEvent: (e) => void events.push(e),
      resolveAttachment: opts.resolveAttachment,
      ...(opts.masking ? { masking: opts.masking } : {}),
    },
    opts.internals ?? {},
  );
  const results = events.flatMap((e) => (e.type === "stepFinished" ? [e.result] : []));
  const logs = events.flatMap((e) => (e.type === "log" ? [e.message] : []));
  return { verdict, events, results, files, logs };
}

export async function noBrowserLeftFor(runId: string) {
  expect((await listMarkedBrowsers()).filter((p) => p.runId === runId)).toEqual([]);
}

/** RGB of one pixel of a PNG, decoded by a throwaway browser. */
export async function pixelAt(png: Buffer, x: number, y: number): Promise<number[]> {
  const browser = await chromium.launch({ chromiumSandbox: SANDBOX });
  try {
    const page = await browser.newPage();
    return await page.evaluate(
      async ({ src, x, y }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const g = canvas.getContext("2d")!;
        g.drawImage(img, 0, 0);
        return Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
      },
      { src: `data:image/png;base64,${png.toString("base64")}`, x, y },
    );
  } finally {
    await browser.close();
  }
}

/** Box of an element (optionally inside an iframe) on a fixture page at the default viewport. */
export async function boxOf(url: string, selector: string, frame?: string, afterMs = 0) {
  const browser = await chromium.launch({ chromiumSandbox: SANDBOX });
  try {
    const page = await browser.newPage({ viewport: DEFAULT_DEVICE.viewport });
    await page.goto(url);
    if (afterMs > 0) await page.waitForTimeout(afterMs);
    const root = frame ? page.frameLocator(frame) : page;
    return (await root.locator(selector).boundingBox())!;
  } finally {
    await browser.close();
  }
}
