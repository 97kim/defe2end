import { readJson, route } from "../../../../../../lib/api";
import { deleteSchedule, getSchedule, updateSchedule, updateScheduleSchema } from "../../../../../../lib/schedules";

export const dynamic = "force-dynamic";

type Params = { slug: string; scheduleId: string };

export const GET = route<Params>({ action: "workspace.read", resource: "schedule" }, async ({ params, workspace }) => Response.json(await getSchedule(workspace.id, params.scheduleId)));

/** Any subset of the settings, including `enabled`. Changing the environment needs `confirmValueReset` when values exist (409). */
export const PATCH = route<Params>({ action: "schedule.write", resource: "schedule" }, async ({ request, params, workspace, actor }) => {
  const input = await readJson(request, updateScheduleSchema);
  return Response.json(await updateSchedule(workspace.id, actor.userId, params.scheduleId, input));
});

export const DELETE = route<Params>({ action: "schedule.write", resource: "schedule" }, async ({ params, workspace, actor }) => {
  await deleteSchedule(workspace.id, actor.userId, params.scheduleId);
  return new Response(null, { status: 204 });
});
