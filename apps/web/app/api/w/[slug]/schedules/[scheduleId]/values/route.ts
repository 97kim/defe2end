import { route } from "../../../../../../../lib/api";
import { scheduleValues } from "../../../../../../../lib/schedules";

export const dynamic = "force-dynamic";

/** The environment's personal variables with the schedule's own value (secrets: `hasValue` only) and its login session status. */
export const GET = route<{ slug: string; scheduleId: string }>({ action: "workspace.read", resource: "schedule" }, async ({ params, workspace }) => Response.json(await scheduleValues(workspace.id, params.scheduleId)));
