import { z } from "zod";
import { errorResponse, readJson } from "../../../../lib/api";
import { getDb } from "../../../../lib/db";
import { isMcpTokenLive, issueMcpToken, lockMcpDevices, mcpRoute } from "../../../../lib/mcp/auth";

export const dynamic = "force-dynamic";

const refreshSchema = z.strictObject({ clientHint: z.enum(["claude", "codex"]).optional() });

/**
 * Refresh (stage 6 contract section 3): a new token for the same device; this one keeps working until the new
 * one is first used (plus a minute). Refreshes of one device run one at a time (device row lock).
 */
export const POST = mcpRoute({ action: "desktop.connect", resource: "instance" }, async ({ request, mcp }) => {
  const body = request.headers.get("content-length") === "0" ? {} : await readJson(request, refreshSchema).catch(() => ({}));
  const issued = await getDb().$transaction(async (tx) => {
    await lockMcpDevices(tx, { deviceId: mcp.deviceId });
    // A revocation may have committed while this waited for the lock.
    if (!(await isMcpTokenLive(tx, mcp.tokenId))) return null;
    return issueMcpToken(tx, { userId: mcp.userId, deviceId: mcp.deviceId, clientHint: (body as { clientHint?: "claude" | "codex" }).clientHint });
  });
  if (!issued) return errorResponse("unauthenticated", "A valid MCP token is required");
  return Response.json(issued, { status: 201 });
});

/** Revokes the calling token (app logout). */
export const DELETE = mcpRoute({ action: "desktop.connect", resource: "instance" }, async ({ mcp }) => {
  await getDb().$transaction(async (tx) => {
    await lockMcpDevices(tx, { deviceId: mcp.deviceId });
    await tx.mcpToken.update({ where: { id: mcp.tokenId }, data: { revokedAt: new Date() } });
  });
  return new Response(null, { status: 204 });
});
