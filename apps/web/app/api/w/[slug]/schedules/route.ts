import { readJson, route } from "../../../../../lib/api";
import { createSchedule, createScheduleSchema, listSchedules } from "../../../../../lib/schedules";

export const dynamic = "force-dynamic";

export const GET = route({ action: "workspace.read", resource: "schedule" }, async ({ workspace }) => Response.json({ schedules: await listSchedules(workspace.id) }));

export const POST = route({ action: "schedule.write", resource: "schedule" }, async ({ request, workspace, actor }) => {
  const input = await readJson(request, createScheduleSchema);
  return Response.json(await createSchedule(workspace, actor.userId, input), { status: 201 });
});
