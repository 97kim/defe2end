// Completions on disk until the server takes them (stage 4 contract section 4.3, desktop spec 2.4).
// Written before the first send, one file per run, under a folder named after the SHA-256 of the server
// origin. A file is sent only while its origin, user and device match the current token.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { desktopCompleteRequestSchema, maskSecrets, runFinalizedSchema, type DesktopCompleteRequest } from "@defe2end/shared";
import { readBody, type DesktopApi } from "./api-client.js";

export interface OutboxEntry {
  version: 1;
  origin: string;
  userId: string;
  deviceId: string;
  runId: string;
  savedAt: string;
  body: DesktopCompleteRequest;
}

/** `done`: the server settled it (2xx or `run_finalized`); `quarantine`: never send again; `retry`: later. */
export type SendOutcome = "done" | "quarantine" | "retry";

export interface Owner {
  userId: string;
  deviceId: string;
}

export interface OutboxOptions {
  /** App data folder; the outbox lives under `{rootDir}/outbox/{sha256(origin)}`. */
  rootDir: string;
  origin: string;
  /** The current token's owner; null while there is none (nothing is sent). */
  owner(): Owner | null;
  send(entry: OutboxEntry): Promise<SendOutcome>;
  /** A run's completion left the outbox (sent or quarantined): its heartbeat may stop. */
  onSettled?(runId: string): void;
  log?(message: string): void;
  sleep?(ms: number): Promise<void>;
}

/** Immediate, 0.5 s, 1.5 s; then one shared backoff timer of 5, 15, 60, 60… seconds. */
export const OUTBOX_BURST_MS = [0, 500, 1_500] as const;
export const OUTBOX_BACKOFF_MS = [5_000, 15_000, 60_000] as const;

export function outboxDir(rootDir: string, origin: string): string {
  return path.join(rootDir, "outbox", createHash("sha256").update(origin).digest("hex"));
}

/** Text fields of a step result that can hold what the user typed or the page showed. */
const STEP_TEXT_FIELDS = ["name", "errorMessage", "expected", "actual"] as const;

/**
 * Masks the user text of a completion (step names, error messages, expected and actual values). Statuses,
 * ids, the claim token and numbers are left alone: a secret that happens to be "passed" must not change them.
 */
export function maskCompletion(body: DesktopCompleteRequest, secrets: readonly string[]): DesktopCompleteRequest {
  return {
    ...body,
    steps: body.steps.map((step) => {
      const masked = { ...step };
      for (const field of STEP_TEXT_FIELDS) {
        const value = masked[field];
        if (value !== undefined) masked[field] = maskSecrets(value, secrets);
      }
      return masked;
    }),
  };
}

const RUN_FILE = /^run-([A-Za-z0-9_-]{1,64})\.json$/;

export class Outbox {
  readonly dir: string;
  private readonly entries = new Map<string, OutboxEntry>();
  private readonly sending = new Set<string>();
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffStep = 0;
  private closed = false;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: OutboxOptions) {
    this.dir = outboxDir(opts.rootDir, opts.origin);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get quarantineDir(): string {
    return path.join(this.dir, "quarantine");
  }

  private file(runId: string): string {
    return path.join(this.dir, `run-${runId}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.quarantineDir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
  }

  private mine(entry: OutboxEntry): boolean {
    const owner = this.opts.owner();
    return !!owner && entry.origin === this.opts.origin && entry.userId === owner.userId && entry.deviceId === owner.deviceId;
  }

  /** Runs whose completion still waits for the current owner (`Defe2end-Active-Runs`, back-pressure). */
  pendingRunIds(): string[] {
    return [...this.entries.values()].filter((e) => this.mine(e)).map((e) => e.runId);
  }

  /** Reads what an earlier session left behind; unreadable files go to quarantine. */
  async load(): Promise<void> {
    await this.ensureDir();
    for (const name of await readdir(this.dir)) {
      const match = RUN_FILE.exec(name);
      if (!match) continue;
      try {
        const entry = JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as OutboxEntry;
        if (entry.version !== 1 || entry.runId !== match[1] || typeof entry.origin !== "string" || typeof entry.userId !== "string" || typeof entry.deviceId !== "string") throw new Error("bad shape");
        entry.body = desktopCompleteRequestSchema.parse(entry.body);
        this.entries.set(entry.runId, entry);
      } catch {
        this.opts.log?.(`outbox: unreadable file ${name} quarantined`);
        await rename(path.join(this.dir, name), path.join(this.quarantineDir, `${Date.now()}-${name}`)).catch(() => {});
      }
    }
  }

  /** Masks, writes to disk, then sends (immediate, 0.5 s, 1.5 s); afterwards the shared backoff takes over. */
  async add(runId: string, owner: Owner, body: DesktopCompleteRequest, secrets: readonly string[]): Promise<void> {
    const entry: OutboxEntry = { version: 1, origin: this.opts.origin, ...owner, runId, savedAt: new Date().toISOString(), body: maskCompletion(body, secrets) };
    await this.ensureDir();
    const tmp = path.join(this.dir, `.tmp-${randomUUID()}`);
    await writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
    await rename(tmp, this.file(runId));
    this.entries.set(runId, entry);
    for (const delay of OUTBOX_BURST_MS) {
      if (delay) await this.sleep(delay);
      if (this.closed || !this.entries.has(runId)) return;
      if ((await this.trySend(runId)) !== "retry") return;
    }
    this.scheduleBackoff();
  }

  /** One try for every pending entry (on `connected` and on the backoff timer). */
  async flush(): Promise<void> {
    let left = false;
    for (const runId of this.pendingRunIds()) if ((await this.trySend(runId)) === "retry") left = true;
    if (left) this.scheduleBackoff();
    else this.backoffStep = 0;
  }

  close(): void {
    this.closed = true;
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
  }

  private scheduleBackoff(): void {
    if (this.closed || this.backoffTimer) return;
    const delay = OUTBOX_BACKOFF_MS[Math.min(this.backoffStep, OUTBOX_BACKOFF_MS.length - 1)]!;
    this.backoffStep++;
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      void this.flush();
    }, delay);
  }

  private async trySend(runId: string): Promise<SendOutcome> {
    const entry = this.entries.get(runId);
    if (!entry || !this.mine(entry) || this.sending.has(runId)) return "retry";
    this.sending.add(runId);
    try {
      let outcome: SendOutcome;
      try {
        outcome = await this.opts.send(entry);
      } catch {
        outcome = "retry";
      }
      if (outcome === "retry" || this.entries.get(runId) !== entry) return outcome;
      this.entries.delete(runId);
      if (outcome === "done") await rm(this.file(runId), { force: true });
      else await rename(this.file(runId), path.join(this.quarantineDir, `${Date.now()}-run-${runId}.json`)).catch(() => {});
      this.opts.onSettled?.(runId);
      return outcome;
    } finally {
      this.sending.delete(runId);
    }
  }
}

/** `POST …/complete` and what each answer means for the stored file. */
export async function sendCompletion(api: Pick<DesktopApi, "request">, entry: OutboxEntry): Promise<SendOutcome> {
  const res = await api.request(`/api/desktop/runs/${encodeURIComponent(entry.runId)}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: () => JSON.stringify(entry.body),
  });
  const body = await readBody(res);
  if (res.ok) return "done";
  if (res.status === 409 && runFinalizedSchema.safeParse(body).success) return "done";
  // Not ours, deleted, or the lease is gone: the server will never take this one.
  if (res.status === 404 || (res.status === 409 && (body as { code?: unknown } | null)?.code === "lease_lost")) return "quarantine";
  return "retry";
}
