import { API_V1_WAIT } from "@defe2end/shared";
import { ApiV1Error, botRoute, waitForApiRun } from "../../../../../lib/api-v1";

export const dynamic = "force-dynamic";

export const GET = botRoute<{ id: string }>("runs:read", async ({ request, params, bot }) => {
  const raw = new URL(request.url).searchParams.get("wait");
  const wait = raw === null ? 0 : Number(raw);
  if (!Number.isInteger(wait) || wait < 0 || wait > API_V1_WAIT.maxSeconds) throw new ApiV1Error("invalid_request", `wait must be a whole number of seconds from 0 to ${API_V1_WAIT.maxSeconds}`);
  return Response.json(await waitForApiRun(request, bot, params.id, wait));
});
