// SSE `GET /api/desktop/stream` (stage 4 contract sections 3.2, 4.1 and 4.4). Connection state lives in
// `DesktopDevice` (not in this process), so any web process can hold a device's stream. Each poll re-checks
// the token and user, closes when a newer connection of the device took over, sends runs that may start and
// `stop-run` for cancel requests.
import {
  cancelRequestedRuns,
  connectDevice,
  dispatchCandidates,
  failDesktopRun,
  isCurrentConnection,
  markDispatched,
  touchDeviceConnection,
} from "@defe2end/db";
import {
  can,
  compareVersions,
  DESKTOP_HEADERS,
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_TIMINGS,
  parseCommaList,
  parseDesktopClientHeader,
  missingCapabilities,
  runOptionsSchema,
  runSnapshotSchema,
  type DesktopStreamMessage,
  type Role,
  type RunTrigger,
} from "@defe2end/shared";
import type { Prisma } from "@defe2end/db";
import { runCapabilities } from "../run-create";
import { getDb } from "../db";
import { bearerToken, desktopError, verifyDesktopToken, type DesktopPrincipal } from "./auth";
import { restoreCapture, takeCaptures, type TakenCapture } from "./capture";
import { desktopMinVersion } from "./config";
import { AuthSessionMissingError, buildRunMessage, VariableMissingError } from "./run-message";

export const PERMISSION_LOST_MESSAGE = "The requester can no longer run scenarios in this workspace, so the run was not sent.";

const SERVER_VERSION = process.env.npm_package_version || "0.0.0";

export type StreamOpen = { ok: false; response: Response } | { ok: true; session: DesktopStreamSession };

/** Checks the request and records the connection. Reconciliation runs before the first message. */
export async function openDesktopStream(request: Request): Promise<StreamOpen> {
  const principal = await verifyDesktopToken(bearerToken(request));
  if (!principal) return { ok: false, response: desktopError(401, "unauthenticated") };
  const client = parseDesktopClientHeader(request.headers.get(DESKTOP_HEADERS.client));
  const minimum = desktopMinVersion();
  if (!client || client.protocol !== DESKTOP_PROTOCOL_VERSION || compareVersions(client.app, minimum) < 0) {
    return { ok: false, response: desktopError(426, "app_update_required", { minimum, ...(process.env.DESKTOP_DOWNLOAD_URL ? { downloadUrl: process.env.DESKTOP_DOWNLOAD_URL } : {}) }) };
  }
  const capabilities = parseCommaList(request.headers.get(DESKTOP_HEADERS.capabilities));
  const activeRuns = parseCommaList(request.headers.get(DESKTOP_HEADERS.activeRuns));
  const db = getDb();
  const { connectionId } = await connectDevice(db, principal.deviceId, { appVersion: client.app, runnerVersion: client.runner, capabilities }, activeRuns);
  return { ok: true, session: new DesktopStreamSession(principal, connectionId, minimum) };
}

export class DesktopStreamSession {
  private lastTouch = Date.now();
  private lastHeartbeat = Date.now();
  private readonly stopSent = new Set<string>();
  /** Capture requests taken by the last tick, until written (or put back when writing fails). */
  private readonly takenCaptures = new Map<string, TakenCapture>();
  closed = false;

  constructor(
    readonly principal: DesktopPrincipal,
    readonly connectionId: string,
    private readonly minimum: string,
  ) {}

  async connectedMessage(): Promise<DesktopStreamMessage> {
    const setting = await getDb().instanceSetting.findUnique({ where: { id: 1 }, select: { recorderTestAttributes: true } });
    const testAttributes = setting?.recorderTestAttributes ?? [];
    return { type: "connected", connectionId: this.connectionId, minimum: this.minimum, serverVersion: SERVER_VERSION, recorder: { testAttributes } };
  }

  /** One poll. Returns the messages to send; `closed` is set when the stream must end. */
  async tick(now = Date.now()): Promise<DesktopStreamMessage[]> {
    if (this.closed) return [];
    const db = getDb();
    const { deviceId, userId } = this.principal;
    // Token revoked or expired, user disabled, or a newer connection of this device: close.
    const token = await db.desktopToken.findUnique({ where: { tokenHash: this.principal.tokenHash }, select: { revokedAt: true, expiresAt: true, user: { select: { disabledAt: true } } } });
    if (!token || token.revokedAt || token.expiresAt <= new Date() || token.user.disabledAt || !(await isCurrentConnection(db, deviceId, this.connectionId))) {
      this.closed = true;
      return [];
    }
    if (now - this.lastTouch >= DESKTOP_TIMINGS.lastSeenRefreshMs) {
      this.lastTouch = now;
      if (!(await touchDeviceConnection(db, deviceId, this.connectionId))) {
        this.closed = true;
        return [];
      }
    }

    const out: DesktopStreamMessage[] = [];
    for (const runId of await dispatchCandidates(db, deviceId)) {
      const run = await markDispatched(db, runId, deviceId, this.connectionId, { check: missingOnThisConnection });
      if (!run) continue;
      if ("refused" in run) {
        await failDesktopRun(db, runId, ["queued"], "app_update_required", run.refused);
        continue;
      }
      // Ownership: the run's requester must be the token's user, and still allowed to run in that workspace.
      if (run.requestedById !== userId || !(await canStillRun(userId, run.workspaceId))) {
        await failDesktopRun(db, run.id, ["queued"], "permission_lost", PERMISSION_LOST_MESSAGE);
        continue;
      }
      try {
        out.push(await buildRunMessage(run));
      } catch (err) {
        if (err instanceof AuthSessionMissingError) await failDesktopRun(db, run.id, ["queued"], "auth_session_missing", err.message);
        else if (err instanceof VariableMissingError) await failDesktopRun(db, run.id, ["queued"], "variable_missing", err.message);
        else throw err;
      }
    }
    for (const taken of await takeCaptures(deviceId, this.connectionId, now)) {
      this.takenCaptures.set(taken.message.requestId, taken);
      out.push(taken.message);
    }
    try {
      for (const runId of await cancelRequestedRuns(db, deviceId)) {
        if (this.stopSent.has(runId)) continue;
        this.stopSent.add(runId);
        out.push({ type: "stop-run", runId });
      }
    } catch (err) {
      // Taken but never handed to the stream: put the capture requests back before failing.
      await this.restoreUnwritten();
      throw err;
    }
    if (out.length > 0) this.lastHeartbeat = now;
    else if (now - this.lastHeartbeat >= DESKTOP_TIMINGS.sseHeartbeatMs) {
      this.lastHeartbeat = now;
      out.push({ type: "heartbeat" });
    }
    return out;
  }

  /** Puts back every capture request taken but not written yet (any failure, or the stream ending). */
  async restoreUnwritten(): Promise<void> {
    const pending = [...this.takenCaptures.values()];
    this.takenCaptures.clear();
    for (const taken of pending) await restoreCapture(this.principal.deviceId, taken).catch((err: unknown) => console.error("capture request not restored", (err as Error).message));
  }

  /** The stream wrote (`ok`) or failed to write this message; a capture request that wasn't written goes back. */
  async written(message: DesktopStreamMessage, ok: boolean): Promise<void> {
    if (message.type !== "capture-auth-state") return;
    const taken = this.takenCaptures.get(message.requestId);
    this.takenCaptures.delete(message.requestId);
    if (!ok && taken) await restoreCapture(this.principal.deviceId, taken);
  }
}

/**
 * The app may have reconnected with fewer capabilities than when the run was created: check again against
 * this connection's list right before sending (stage 4 contract section 3.3).
 */
async function missingOnThisConnection(
  tx: Prisma.TransactionClient,
  run: { trigger: string; snapshot: unknown; options: unknown; environmentId: string | null; comparisonId: string | null },
  capabilities: string[],
): Promise<string | null> {
  const snapshot = runSnapshotSchema.parse(run.snapshot);
  const environment = run.environmentId ? await tx.environment.findUnique({ where: { id: run.environmentId }, select: { useAuthSession: true } }) : null;
  const missing = missingCapabilities(
    runCapabilities({
      steps: snapshot.scenario.steps,
      trigger: run.trigger as RunTrigger,
      video: runOptionsSchema.parse(run.options ?? {}).video === true,
      useAuthSession: environment?.useAuthSession === true,
      comparisonChild: run.comparisonId !== null,
    }),
    capabilities,
  );
  return missing.length > 0 ? `${APP_UPDATE_MESSAGE} Missing: ${missing.join(", ")}` : null;
}

export const APP_UPDATE_MESSAGE = "The connected desktop app can't run this. Update the app.";

/** `run.create` re-checked against the current user row and membership (stage 3 principle). */
async function canStillRun(userId: string, workspaceId: string): Promise<boolean> {
  const user = await getDb().user.findUnique({
    where: { id: userId },
    select: { disabledAt: true, isInstanceAdmin: true, memberships: { where: { workspaceId }, select: { role: true } } },
  });
  if (!user || user.disabledAt) return false;
  const role = user.memberships[0]?.role;
  const roles: Record<string, Role> = role ? { [workspaceId]: role } : {};
  return can({ userId, isInstanceAdmin: user.isInstanceAdmin, roles }, "run.create", { type: "run", workspaceId }) === "allow";
}

/** The SSE response: polls every second until the client goes away or the session closes. */
export function streamResponse(session: DesktopStreamSession, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (message: DesktopStreamMessage) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
      const close = () => {
        session.closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      signal.addEventListener("abort", close);
      try {
        send(await session.connectedMessage());
        while (!session.closed && !signal.aborted) {
          const messages = await session.tick();
          for (const [i, message] of messages.entries()) {
            try {
              send(message);
              await session.written(message, true);
            } catch (err) {
              // The client went away mid-write: put back what wasn't delivered, then stop.
              for (const unsent of messages.slice(i)) await session.written(unsent, false);
              throw err;
            }
          }
          if (session.closed) break;
          await new Promise((resolve) => setTimeout(resolve, DESKTOP_TIMINGS.dispatchPollMs));
        }
      } catch (err) {
        console.error("desktop stream failed", (err as Error).message);
      } finally {
        await session.restoreUnwritten();
      }
      close();
    },
    cancel() {
      session.closed = true;
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
