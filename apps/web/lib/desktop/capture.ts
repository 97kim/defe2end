// `capture-auth-state` requests (stage 4 contract section 5) waiting for the device's stream. Kept in the
// database so a request reaches the device whichever web process holds its stream (contract section 3.2).
// One per device — a new capture replaces the previous one (the app drops an unfinished capture anyway) —
// and a request expires after a minute.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@defe2end/db";
import type { DesktopStreamMessage } from "@defe2end/shared";
import { getDb } from "../db";

type CaptureMessage = Extract<DesktopStreamMessage, { type: "capture-auth-state" }>;
const TTL_MS = 60_000;

export async function queueCapture(deviceId: string, input: Omit<CaptureMessage, "type" | "requestId">): Promise<CaptureMessage> {
  const message: CaptureMessage = { type: "capture-auth-state", requestId: randomUUID(), ...input };
  const json = message as unknown as Prisma.InputJsonValue;
  await getDb().desktopCaptureRequest.upsert({
    where: { deviceId },
    create: { deviceId, message: json },
    update: { message: json, createdAt: new Date() },
  });
  return message;
}

export interface TakenCapture {
  message: CaptureMessage;
  createdAt: Date;
}

/**
 * Takes the device's request at most once, and only for the device's current connection: under the device
 * row lock (same order as dispatch: device first), so a stream a newer connection replaced gets nothing and
 * leaves the request for the new one. The delete is the claim, so two streams can't both send it.
 */
export async function takeCaptures(deviceId: string, connectionId: string, now = Date.now()): Promise<TakenCapture[]> {
  return getDb().$transaction(async (tx) => {
    const [device] = await tx.$queryRaw<{ connectionId: string | null }[]>`SELECT "connectionId" FROM "DesktopDevice" WHERE id = ${deviceId} FOR SHARE`;
    if (device?.connectionId !== connectionId) return [];
    const rows = await tx.$queryRaw<{ message: CaptureMessage; createdAt: Date }[]>`
      DELETE FROM "DesktopCaptureRequest" WHERE "deviceId" = ${deviceId} RETURNING message, "createdAt"`;
    return rows.filter((r) => now - r.createdAt.getTime() < TTL_MS);
  });
}

/** Puts back a request the stream failed to write, unless a newer request took its place meanwhile. */
export async function restoreCapture(deviceId: string, taken: TakenCapture): Promise<void> {
  const json = taken.message as unknown as Prisma.InputJsonValue;
  await getDb().$executeRaw`
    INSERT INTO "DesktopCaptureRequest" ("deviceId", message, "createdAt") VALUES (${deviceId}, ${json}::jsonb, ${taken.createdAt})
    ON CONFLICT ("deviceId") DO NOTHING`;
}
