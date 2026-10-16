import { DESKTOP_TIMINGS } from "@defe2end/shared";
import { route } from "../../../../lib/api";
import { getDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";

/** The caller's own desktop devices for the run dialog's PC choice; online = seen within 45 seconds. */
export const GET = route({ action: "desktop.connect", resource: "instance" }, async ({ actor }) => {
  const rows = await getDb().desktopDevice.findMany({ where: { userId: actor.userId }, orderBy: { lastSeenAt: { sort: "desc", nulls: "last" } } });
  const since = Date.now() - DESKTOP_TIMINGS.onlineWindowMs;
  return Response.json({
    items: rows.map((d) => ({
      id: d.id,
      label: d.label,
      appVersion: d.appVersion,
      online: d.connectionId !== null && d.lastSeenAt !== null && d.lastSeenAt.getTime() > since,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    })),
  });
});
