import { desktopTokenRequestSchema } from "@defe2end/shared";
import { ApiError, readJson, route } from "../../../../lib/api";
import { bearerToken, desktopError, issueDesktopToken, originMatches, revokeUserDesktopTokens, verifyDesktopToken } from "../../../../lib/desktop/auth";
import { getDb } from "../../../../lib/db";
import { revokeMcpTokens } from "../../../../lib/mcp/auth";

export const dynamic = "force-dynamic";

/**
 * Token exchange (stage 4 contract section 3.1): the app's main process calls it with the web session cookie
 * of its main window. `Origin` must be this server, so another site can't mint a token with the cookie.
 */
export const POST = route({ action: "desktop.connect", resource: "instance" }, async ({ request, actor }) => {
  if (!originMatches(request)) throw new ApiError("forbidden", "Origin must be this server");
  const body = await readJson(request, desktopTokenRequestSchema);
  return Response.json(await issueDesktopToken({ userId: actor.userId, installId: body.installId, label: body.label }));
});

/** Web sign-in revocation: every token of the session's user. `Origin` must be this server. */
const revokeAllForSession = route({ action: "desktop.connect", resource: "instance" }, async ({ request, actor }) => {
  if (!originMatches(request)) throw new ApiError("forbidden", "Origin must be this server");
  await revokeUserDesktopTokens(actor.userId);
  return new Response(null, { status: 204 });
});

/**
 * Revocation (stage 4 contract section 9). With `Authorization: Bearer` (the app on logout or server change,
 * no cookie): that token only, after checking it — an invalid one is 401. Otherwise the web session's user's
 * tokens, all of them.
 */
export const DELETE = Object.assign(
  async (request: Request, context: { params: Promise<Record<string, string>> }) => {
    const token = bearerToken(request);
    if (!token) return revokeAllForSession(request, context);
    const principal = await verifyDesktopToken(token);
    if (!principal) return desktopError(401, "unauthenticated");
    await getDb().desktopToken.updateMany({ where: { tokenHash: principal.tokenHash, revokedAt: null }, data: { revokedAt: new Date() } });
    // App logout or server change: the device's MCP tokens too (stage 6 contract section 3).
    await revokeMcpTokens(getDb(), { deviceId: principal.deviceId });
    return new Response(null, { status: 204 });
  },
  { routeSpec: revokeAllForSession.routeSpec },
);
