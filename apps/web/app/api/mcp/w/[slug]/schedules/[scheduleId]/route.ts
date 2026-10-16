import { ApiError, readJson } from "../../../../../../../lib/api";
import { mcpRoute } from "../../../../../../../lib/mcp/auth";
import { getSchedule, updateSchedule, updateScheduleSchema } from "../../../../../../../lib/schedules";
import * as web from "../../../../../w/[slug]/schedules/[scheduleId]/route";

export const dynamic = "force-dynamic";

export const GET = mcpRoute(web.GET);

/**
 * `update_schedule`, including turning it off. A change that would delete the schedule's own values (another
 * environment) is refused here and has no confirmation flag (stage 6 contract section 4). No delete.
 */
export const PATCH = mcpRoute({ action: "schedule.write", resource: "schedule" }, async ({ request, params, workspace, actor }) => {
  const input = await readJson(request, updateScheduleSchema);
  if (input.confirmValueReset !== undefined) throw new ApiError("invalid_request", "confirmValueReset is not available here");
  const scheduleId = params.scheduleId as string;
  if (input.environmentId !== undefined && input.environmentId !== (await getSchedule(workspace!.id, scheduleId)).environmentId) {
    throw new ApiError("forbidden", "Changing a schedule's environment deletes its own values; do it on the web");
  }
  return Response.json(await updateSchedule(workspace!.id, actor.userId, scheduleId, input));
});
