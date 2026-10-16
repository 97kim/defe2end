import { route } from "../../../../../../lib/api";
import { cronPreviewSchema, previewCron } from "../../../../../../lib/schedules";

export const dynamic = "force-dynamic";

/** `?cron=&timezone=`: checks an expression and lists its next 5 times (`{ ok: false, code, message }` when it isn't valid). */
export const GET = route({ action: "workspace.read", resource: "schedule" }, async ({ request }) => {
  const query = new URL(request.url).searchParams;
  const parsed = cronPreviewSchema.safeParse({ cron: query.get("cron") ?? "", timezone: query.get("timezone") ?? "" });
  if (!parsed.success) return Response.json({ ok: false, code: "cron_invalid", message: "Missing cron or timezone" });
  return Response.json(previewCron(parsed.data.cron, parsed.data.timezone));
});
