import { z } from "zod";
import { ApiError, readJson, route } from "../../../../lib/api";
import { hashDesktopToken, originMatches } from "../../../../lib/desktop/auth";
import { getDb } from "../../../../lib/db";
import { issueMcpToken, lockMcpDevices } from "../../../../lib/mcp/auth";

export const dynamic = "force-dynamic";

/** `desktopToken`: the app's live device token, so an MCP token is only issued inside a live device generation. */
const bodySchema = z.strictObject({ installId: z.uuid(), desktopToken: z.string().min(1).max(512), clientHint: z.enum(["claude", "codex"]).optional() });

/**
 * MCP token exchange (stage 6 contract section 3): the app's main process calls it with the web session cookie,
 * like the desktop token exchange, and proves the device generation with its desktop token. One at a time per
 * device: the device row is locked, and everything is re-checked after locking.
 */
export const POST = route({ action: "desktop.connect", resource: "instance" }, async ({ request, actor }) => {
  if (!originMatches(request)) throw new ApiError("forbidden", "Origin must be this server");
  const body = await readJson(request, bodySchema);
  const issued = await getDb().$transaction(async (tx) => {
    const device = await tx.desktopDevice.findUnique({ where: { installId_userId: { installId: body.installId, userId: actor.userId } }, select: { id: true } });
    if (!device) throw new ApiError("not_found", "Connect the desktop app first");
    await lockMcpDevices(tx, { deviceId: device.id });
    // Sign-out or deactivation may have committed while this waited for the lock: re-check the session and user.
    // A server change or app logout revokes the desktop token without touching the web session: it must still be live.
    const now = new Date();
    const [session, user, desktop] = await Promise.all([
      tx.session.findUnique({ where: { id: actor.sessionId }, select: { expiresAt: true } }),
      tx.user.findUnique({ where: { id: actor.userId }, select: { disabledAt: true } }),
      tx.desktopToken.findFirst({ where: { tokenHash: hashDesktopToken(body.desktopToken), userId: actor.userId, deviceId: device.id, revokedAt: null, expiresAt: { gt: now } }, select: { id: true } }),
    ]);
    if (!session || session.expiresAt <= now || !user || user.disabledAt || !desktop) throw new ApiError("unauthenticated", "Sign in again");
    return { deviceId: device.id, ...(await issueMcpToken(tx, { userId: actor.userId, deviceId: device.id, clientHint: body.clientHint })) };
  });
  return Response.json(issued, { status: 201 });
});
