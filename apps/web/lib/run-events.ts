// Live run progress over SSE (stage 3 contract section 7). One DB read per second per connection; no broker,
// no LISTEN/NOTIFY. Every poll re-checks the session, the user's active state and `run.read`: once any of
// them is gone the stream closes without sending anything more.
import { can, isTerminalRunStatus } from "@defe2end/shared";
import { getActor } from "./actor";
import { diffRun, type RunEvent } from "./run-event-merge";
import { findRunDetail } from "./run-read";

export const RUN_EVENTS_POLL_MS = 1_000;
const KEEPALIVE_MS = 15_000;

/** Open streams per user in this server process (contract: a per-user connection cap). */
export function maxConnectionsPerUser(): number {
  const n = Number(process.env.SSE_MAX_CONNECTIONS_PER_USER);
  return Number.isInteger(n) && n > 0 ? n : 8;
}

const globalForStreams = globalThis as { runEventStreams?: Map<string, number> };
const open = (globalForStreams.runEventStreams ??= new Map());

export function openStreamCount(userId: string): number {
  return open.get(userId) ?? 0;
}

async function stillAllowed(headers: Headers, workspaceId: string): Promise<boolean> {
  const actor = await getActor(headers);
  return actor !== null && can(actor, "run.read", { type: "run", workspaceId }) === "allow";
}

/**
 * The response for `GET …/runs/[id]/events`. route() has checked the session and `run.read`; this checks the run
 * belongs to the workspace (404 otherwise) and the per-user cap (429), then streams until the run ends, the
 * client goes away or access is lost.
 */
export async function runEventsResponse(opts: {
  request: Request;
  workspace: { id: string; slug: string };
  userId: string;
  runId: string;
  pollMs?: number;
}): Promise<Response | null> {
  const { request, workspace, userId, runId } = opts;
  const pollMs = opts.pollMs ?? RUN_EVENTS_POLL_MS;
  const first = await findRunDetail(workspace, runId);
  if (!first) return null;
  if (openStreamCount(userId) >= maxConnectionsPerUser()) {
    return Response.json(
      { error: { code: "too_many_connections", message: "Too many live views are open. Close some tabs and reload." } },
      { status: 429, headers: { "cache-control": "no-store" } },
    );
  }
  open.set(userId, openStreamCount(userId) + 1);

  const headers = new Headers(request.headers);
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const release = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearInterval(keepalive);
    request.signal.removeEventListener("abort", release);
    const left = openStreamCount(userId) - 1;
    if (left > 0) open.set(userId, left);
    else open.delete(userId);
    try {
      controllerRef?.close();
    } catch {
      // Already closed by the client.
    }
  };
  const send = (event: RunEvent) => {
    if (!closed) controllerRef?.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  };

  let last = first;
  const poll = async () => {
    if (closed) return;
    try {
      if (!(await stillAllowed(headers, workspace.id))) return release();
      const next = await findRunDetail(workspace, runId);
      if (!next) return release();
      if (closed) return;
      const update = diffRun(last, next);
      last = next;
      if (update) send(update);
      if (isTerminalRunStatus(next.status)) {
        send({ type: "end" });
        return release();
      }
    } catch (err) {
      console.error("run events poll failed", err);
      return release();
    }
    timer = setTimeout(() => void poll(), pollMs);
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (request.signal.aborted) return release();
      request.signal.addEventListener("abort", release);
      controller.enqueue(encoder.encode(`retry: 3000\n\n`));
      send({ type: "snapshot", run: first });
      if (isTerminalRunStatus(first.status)) {
        send({ type: "end" });
        return release();
      }
      keepalive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: keepalive\n\n`));
      }, KEEPALIVE_MS);
      timer = setTimeout(() => void poll(), pollMs);
    },
    cancel: release,
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
