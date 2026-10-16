import { authSessionTargetSchema, DESKTOP_TIMINGS } from "@defe2end/shared";
import { z } from "zod";
import { ApiError, route } from "../../../../../../../../lib/api";
import { authorizeSessionTarget } from "../../../../../../../../lib/auth-sessions";
import { getDb } from "../../../../../../../../lib/db";
import { queueCapture } from "../../../../../../../../lib/desktop/capture";
import { DESKTOP_NOT_CONNECTED_MESSAGE } from "../../../../../../../../lib/run-create";

export const dynamic = "force-dynamic";

/**
 * Asks the caller's desktop app to open a visible browser on the environment and register the login made
 * there (`capture-auth-state`, stage 4 contract section 5). Answers the `requestId` the registration echoes.
 */
export const POST = route<{ slug: string; environmentId: string }>({ action: "authSession.write", resource: "authSession" }, async ({ request, params, workspace, actor }) => {
  const db = getDb();
  // Body (optional): { target } — the caller themself by default, or a schedule / bot token (stage 5 section 1.1).
  const body = request.headers.get("content-length") === "0" || !request.body ? {} : await request.json().catch(() => ({}));
  const target = captureBodySchema.parse(body ?? {}).target ?? { kind: "user" as const };
  const environment = await db.environment.findFirst({ where: { id: params.environmentId, workspaceId: workspace.id }, select: { id: true, baseUrl: true } });
  if (!environment) throw ApiError.notFound();
  // authSession.write for oneself, schedule.write / botToken.write for the others; foreign targets 404.
  await authorizeSessionTarget(actor.userId, workspace.id, environment.id, target);
  const device = await db.desktopDevice.findFirst({
    where: { userId: actor.userId, connectionId: { not: null }, lastSeenAt: { gt: new Date(Date.now() - DESKTOP_TIMINGS.onlineWindowMs) } },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, capabilities: true },
  });
  if (!device) throw new ApiError("desktop_not_connected", DESKTOP_NOT_CONNECTED_MESSAGE);
  if (!device.capabilities.includes("auth-session")) throw new ApiError("app_update_required", "Update the desktop app to save login sessions.", { missing: ["auth-session"] });
  // Older apps would drop a message with a target they don't know: they get user captures only.
  if (target.kind !== "user" && !device.capabilities.includes("auth-session-target")) {
    throw new ApiError("app_update_required", "Update the desktop app to save a schedule's or bot token's login session.", { missing: ["auth-session-target"] });
  }
  const message = await queueCapture(device.id, { workspaceId: workspace.id, environmentId: environment.id, url: environment.baseUrl, ...(target.kind === "user" ? {} : { target }) });
  return Response.json({ requestId: message.requestId, deviceId: device.id }, { status: 202 });
});

const captureBodySchema = z.object({ target: authSessionTargetSchema.optional() });
