import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopCompleteRequest } from "@defe2end/shared";
import { AccountChangedError, DesktopApi } from "./api-client.js";
import { Generations } from "./generation.js";
import { Outbox, outboxDir, sendCompletion } from "./outbox.js";
import { normalizeServerUrl } from "./server-url.js";
import { SseClient } from "./sse.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const token = (n: number, userId = "u1") => ({ token: `t${n}`, userId, deviceId: "d1", expiresAt: "2026-10-20T00:00:00.000Z" });

function api(fetchImpl: typeof fetch, exchange = vi.fn(async () => token(2)), gens = new Generations()) {
  return new DesktopApi({ origin: "https://e2e.example.com", ticket: gens.ticket(), identity: token(1), exchange, onIdentity: () => {}, fetchImpl, appVersion: "0.1.0", runnerVersion: "0.1.0" });
}

afterEach(() => vi.useRealTimers());

describe("normalizeServerUrl", () => {
  it("keeps the origin only, https by default", () => {
    expect(normalizeServerUrl(" e2e.example.com/app/ ")).toBe("https://e2e.example.com");
    expect(normalizeServerUrl("https://e2e.example.com:8443/x?y#z")).toBe("https://e2e.example.com:8443");
  });
  it("allows http for loopback only", () => {
    expect(normalizeServerUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(normalizeServerUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(normalizeServerUrl("http://e2e.example.com")).toBeNull();
    expect(normalizeServerUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeServerUrl("https://user:pw@e2e.example.com")).toBeNull();
    expect(normalizeServerUrl("")).toBeNull();
  });
});

describe("Generations", () => {
  it("drops callbacks and aborts requests of an old generation", () => {
    const gens = new Generations();
    const old = gens.ticket();
    const seen: number[] = [];
    const cb = gens.guard(old, (n: number) => seen.push(n));
    cb(1);
    gens.next();
    cb(2);
    expect(seen).toEqual([1]);
    expect(old.signal.aborted).toBe(true);
    expect(gens.ticket().current()).toBe(true);
  });
});

describe("DesktopApi", () => {
  it("sends the token in a header, exchanges once on 401 and resends once", async () => {
    const auths: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = (init!.headers as Record<string, string>).Authorization!;
      auths.push(auth);
      return auth === "Bearer t1" ? json(401, {}) : json(200, { ok: true });
    });
    const exchange = vi.fn(async () => token(2));
    const client = api(fetchImpl as typeof fetch, exchange);
    const results = await Promise.all([client.json("/a"), client.json("/b"), client.json("/c")]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(auths.filter((a) => a === "Bearer t2")).toHaveLength(3);
  });

  it("does not resend twice, and leaves 403 alone", async () => {
    const fetchImpl = vi.fn(async () => json(401, {}));
    const exchange = vi.fn(async () => token(2));
    const client = api(fetchImpl as typeof fetch, exchange);
    expect((await client.request("/a")).status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const forbidden = api(vi.fn(async () => json(403, {})) as typeof fetch, exchange);
    expect((await forbidden.request("/a")).status).toBe(403);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("refuses a token of another user", async () => {
    const client = api(vi.fn(async () => json(401, {})) as typeof fetch, vi.fn(async () => token(2, "u2")));
    await expect(client.request("/a")).rejects.toBeInstanceOf(AccountChangedError);
    expect(client.current?.token).toBe("t1");
  });
});

function streamResponse(): { res: Response; push(text: string): void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  return { res: new Response(body, { status: 200 }), push: (text) => controller.enqueue(new TextEncoder().encode(text)) };
}

describe("SseClient", () => {
  it("sends the headers, parses messages and reconnects after 75 s of silence", async () => {
    vi.useFakeTimers();
    const streams: ReturnType<typeof streamResponse>[] = [];
    const headers: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      headers.push(init!.headers as Record<string, string>);
      const s = streamResponse();
      streams.push(s);
      return s.res;
    });
    const messages: string[] = [];
    const client = new SseClient({ api: api(fetchImpl as typeof fetch), ticket: new Generations().ticket(), activeRuns: () => ["r1", "r2"], onMessage: (m) => messages.push(m.type), onUpdateRequired: () => {}, onAccountChanged: () => {}, random: () => 0 });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(headers[0]).toMatchObject({ Authorization: "Bearer t1", "Defe2end-Active-Runs": "r1,r2", "Defe2end-Client": "app=0.1.0; runner=0.1.0; protocol=1" });
    streams[0]!.push('data: {"type":"heartbeat"}\n\ndata: {"type":"stop-run","runId":"r1"}\n\ndata: {"bogus":1}\n\n');
    await vi.advanceTimersByTimeAsync(74_000);
    expect(messages).toEqual(["heartbeat", "stop-run"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it("waits 5 s plus jitter after an error, and stops on 426", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = vi.fn(async () => (++calls === 1 ? json(500, {}) : json(426, { code: "app_update_required", minimum: "1.0.0" })));
    const updates: string[] = [];
    const client = new SseClient({ api: api(fetchImpl as typeof fetch), ticket: new Generations().ticket(), activeRuns: () => [], onMessage: () => {}, onUpdateRequired: (b) => updates.push(b.minimum), onAccountChanged: () => {}, random: () => 0.5 });
    client.start();
    await vi.advanceTimersByTimeAsync(5_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toBe(2);
    expect(updates).toEqual(["1.0.0"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);
  });
});

const completion: DesktopCompleteRequest = {
  claimToken: "c1",
  verdict: "failed",
  stopCause: { type: "none" },
  attemptCount: 1,
  passedAfterRetry: false,
  durationMs: 10,
  steps: [{ index: 0, stepId: "s1", action: "fill", status: "failed", attempt: 1, attempts: 1, startedAt: "2026-10-13T00:00:00.000Z", durationMs: 1, errorMessage: 'typed "hunter2" into #pw' }],
};

describe("Outbox", () => {
  const owner = { userId: "u1", deviceId: "d1" };
  const make = async (send: (e: unknown) => Promise<"done" | "quarantine" | "retry">, current = owner) => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "outbox-"));
    const settled: string[] = [];
    const outbox = new Outbox({ rootDir, origin: "https://e2e.example.com", owner: () => current, send, onSettled: (id) => settled.push(id), sleep: async () => {} });
    return { outbox, rootDir, settled };
  };

  it("writes the masked body to a 0700 folder before sending, then deletes it", async () => {
    let onDisk = "";
    const { outbox, rootDir, settled } = await make(async () => {
      const dir = outboxDir(rootDir, "https://e2e.example.com");
      onDisk = await readFile(path.join(dir, "run-r1.json"), "utf8");
      return "done";
    });
    await outbox.add("r1", owner, completion, ["hunter2"]);
    expect(onDisk).not.toContain("hunter2");
    expect(JSON.parse(onDisk)).toMatchObject({ origin: "https://e2e.example.com", userId: "u1", deviceId: "d1" });
    // POSIX only: Windows has no mode bits (stat always reports 0o666); the per-user app data folder is its guard.
    if (process.platform !== "win32") expect((await stat(outbox.dir)).mode & 0o777).toBe(0o700);
    expect(await readdir(outbox.dir)).toEqual(["quarantine"]);
    expect(settled).toEqual(["r1"]);
  });

  it("tries three times, keeps the file, and resends on flush", async () => {
    let answer: "retry" | "done" = "retry";
    const send = vi.fn(async () => answer);
    const { outbox } = await make(send);
    await outbox.add("r1", owner, completion, []);
    expect(send).toHaveBeenCalledTimes(3);
    expect(outbox.pendingRunIds()).toEqual(["r1"]);
    answer = "done";
    await outbox.flush();
    expect(outbox.pendingRunIds()).toEqual([]);
    outbox.close();
  });

  it("quarantines 404s and unreadable files, and never sends another owner's file", async () => {
    const send = vi.fn(async () => "quarantine" as const);
    const { outbox, rootDir } = await make(send);
    await outbox.add("r1", owner, completion, []);
    expect((await readdir(path.join(outbox.dir, "quarantine"))).length).toBe(1);

    await writeFile(path.join(outbox.dir, "run-bad.json"), "{not json");
    await writeFile(path.join(outbox.dir, "run-r2.json"), JSON.stringify({ version: 1, origin: "https://e2e.example.com", userId: "other", deviceId: "d9", runId: "r2", savedAt: "", body: completion }));
    const other = new Outbox({ rootDir, origin: "https://e2e.example.com", owner: () => owner, send });
    await other.load();
    expect((await readdir(path.join(outbox.dir, "quarantine"))).length).toBe(2);
    send.mockClear();
    await other.flush();
    expect(send).not.toHaveBeenCalled();
    other.close();
  });

  it("maps server answers", async () => {
    const entry = { version: 1 as const, origin: "x", userId: "u1", deviceId: "d1", runId: "r1", savedAt: "", body: completion };
    const answer = (res: Response) => sendCompletion({ request: async () => res }, entry);
    expect(await answer(json(200, {}))).toBe("done");
    expect(await answer(json(409, { code: "run_finalized", status: "error" }))).toBe("done");
    expect(await answer(json(404, {}))).toBe("quarantine");
    expect(await answer(json(409, { code: "lease_lost" }))).toBe("quarantine");
    expect(await answer(json(503, {}))).toBe("retry");
  });

  it("masks user text only, never statuses, ids or the claim token", async () => {
    const { outbox } = await make(async () => "retry");
    const body = { ...completion, verdict: "passed" as const, claimToken: "passed-c1" };
    await outbox.add("r1", owner, body, ["passed", "hunter2"]);
    const stored = JSON.parse(await readFile(path.join(outbox.dir, "run-r1.json"), "utf8"));
    expect(stored.body).toMatchObject({ verdict: "passed", claimToken: "passed-c1", steps: [{ status: "failed", stepId: "s1", action: "fill" }] });
    expect(stored.body.steps[0].errorMessage).not.toContain("hunter2");
    outbox.close();
  });

  it("quarantines a stored completion that doesn't match the schema", async () => {
    const send = vi.fn(async () => "done" as const);
    const { outbox, rootDir } = await make(send);
    await outbox.load();
    await writeFile(path.join(outbox.dir, "run-r3.json"), JSON.stringify({ version: 1, origin: "https://e2e.example.com", userId: "u1", deviceId: "d1", runId: "r3", savedAt: "", body: { ...completion, verdict: "bogus" } }));
    const again = new Outbox({ rootDir, origin: "https://e2e.example.com", owner: () => owner, send });
    await again.load();
    expect(again.pendingRunIds()).toEqual([]);
    expect((await readdir(path.join(outbox.dir, "quarantine"))).length).toBe(1);
  });
});
