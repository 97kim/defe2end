// `GET /api/desktop/stream` client (stage 4 contract section 3.2). Headers, not query parameters, carry the
// token so it stays out of proxy logs.
import { appUpdateRequiredSchema, DESKTOP_HEADERS, DESKTOP_TIMINGS, desktopStreamMessageSchema, type AppUpdateRequired, type DesktopStreamMessage } from "@defe2end/shared";
import { AccountChangedError, readBody, type DesktopApi } from "./api-client.js";
import type { GenerationTicket } from "./generation.js";

export type StreamStatus = "connecting" | "connected" | "disconnected" | "update_required" | "stopped";

export interface SseClientOptions {
  api: DesktopApi;
  ticket: GenerationTicket;
  /** `Defe2end-Active-Runs`: queued, running and stored completions (contract section 4.4). */
  activeRuns(): string[];
  onMessage(message: DesktopStreamMessage): void;
  /** 426: the app is too old or speaks another protocol. The client stops; the app shows its dialog. */
  onUpdateRequired(body: AppUpdateRequired): void;
  /** The token exchange returned another user. The client stops; the caller switches generation. */
  onAccountChanged(): void;
  onStatus?(status: StreamStatus): void;
  log?(message: string): void;
  random?(): number;
}

/** Reconnects after 5 s plus up to 2 s of jitter, or right away after 75 s of silence. */
export class SseClient {
  private attempt = 0;
  private running = false;
  private connection: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: SseClientOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.attempt++;
    this.clearTimers();
    this.connection?.abort();
    this.connection = null;
    this.status("stopped");
  }

  private live(attempt: number): boolean {
    return this.running && attempt === this.attempt && this.opts.ticket.current();
  }

  private status(status: StreamStatus): void {
    this.opts.onStatus?.(status);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.retryTimer = this.idleTimer = null;
  }

  private armIdle(attempt: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.live(attempt)) return;
      this.opts.log?.("stream silent for 75 s, reconnecting");
      this.reconnect(attempt, 0);
    }, DESKTOP_TIMINGS.sseIdleMs);
  }

  private reconnect(attempt: number, delayMs: number): void {
    if (!this.live(attempt)) return;
    this.attempt++;
    this.clearTimers();
    this.connection?.abort();
    this.connection = null;
    this.status("disconnected");
    const next = this.attempt;
    this.retryTimer = setTimeout(() => {
      if (this.live(next)) void this.connect();
    }, delayMs);
  }

  private retryDelay(): number {
    return DESKTOP_TIMINGS.sseRetryMs + Math.floor((this.opts.random ?? Math.random)() * DESKTOP_TIMINGS.sseRetryJitterMs);
  }

  private async connect(): Promise<void> {
    const attempt = ++this.attempt;
    const controller = new AbortController();
    this.connection = controller;
    this.status("connecting");
    this.armIdle(attempt);
    try {
      const res = await this.opts.api.request("/api/desktop/stream", {
        headers: { Accept: "text/event-stream", [DESKTOP_HEADERS.activeRuns]: this.opts.activeRuns().join(",") },
        timeoutMs: 0,
        signal: controller.signal,
      });
      if (!this.live(attempt)) {
        await res.body?.cancel().catch(() => {});
        return;
      }
      if (res.status === 426) {
        const body = appUpdateRequiredSchema.safeParse(await readBody(res));
        this.running = false;
        this.clearTimers();
        this.status("update_required");
        this.opts.onUpdateRequired(body.success ? body.data : { code: "app_update_required", minimum: "" });
        return;
      }
      if (!res.ok || !res.body) {
        // A 401 here already went through one exchange and resend (DesktopApi.request).
        this.opts.log?.(`stream refused: HTTP ${res.status}`);
        await res.body?.cancel().catch(() => {});
        this.reconnect(attempt, this.retryDelay());
        return;
      }
      this.status("connected");
      await this.read(res.body, attempt);
      this.reconnect(attempt, this.retryDelay());
    } catch (err) {
      if (!this.live(attempt)) return;
      if (err instanceof AccountChangedError) {
        this.stop();
        this.opts.onAccountChanged();
        return;
      }
      this.opts.log?.(`stream error: ${err instanceof Error ? err.message : String(err)}`);
      this.reconnect(attempt, this.retryDelay());
    }
  }

  private async read(body: ReadableStream<Uint8Array>, attempt: number): Promise<void> {
    const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !this.live(attempt)) return;
        // Anything at all, even a comment or a message we can't parse, counts as the server being alive.
        this.armIdle(attempt);
        buffer += value;
        let end: number;
        while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
          this.dispatch(block, attempt);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private dispatch(block: string, attempt: number): void {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    let parsed;
    try {
      parsed = desktopStreamMessageSchema.safeParse(JSON.parse(data));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) {
      this.opts.log?.("stream message ignored: unknown shape");
      return;
    }
    if (this.live(attempt)) this.opts.onMessage(parsed.data);
  }
}
