import { readJson, route } from "../../../../../../../../lib/api";
import { deleteScheduleValue, scheduleValueSchema, setScheduleValue } from "../../../../../../../../lib/schedules";

export const dynamic = "force-dynamic";

type Params = { slug: string; scheduleId: string; variableId: string };

export const PUT = route<Params>({ action: "schedule.write", resource: "schedule" }, async ({ request, params, workspace, actor }) => {
  const { value } = await readJson(request, scheduleValueSchema);
  await setScheduleValue(workspace.id, actor.userId, params.scheduleId, params.variableId, value);
  return new Response(null, { status: 204 });
});

export const DELETE = route<Params>({ action: "schedule.write", resource: "schedule" }, async ({ params, workspace, actor }) => {
  await deleteScheduleValue(workspace.id, actor.userId, params.scheduleId, params.variableId);
  return new Response(null, { status: 204 });
});
