import { route } from "../../../../../../../lib/api";
import { listFires } from "../../../../../../../lib/schedules";

export const dynamic = "force-dynamic";

export const GET = route<{ slug: string; scheduleId: string }>({ action: "workspace.read", resource: "schedule" }, async ({ request, params, workspace }) => {
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50) || 50;
  return Response.json({ fires: await listFires(workspace.id, params.scheduleId, limit) });
});
