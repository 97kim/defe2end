import { apiV1CreateRunSchema } from "@defe2end/shared";
import { botRoute, createApiRun, readApiIdempotencyKey } from "../../../../lib/api-v1";
import { readJson } from "../../../../lib/api";

export const dynamic = "force-dynamic";

/** 201 when created, 200 when the same key and body repeat (stage 5 contract section 7). */
export const POST = botRoute("runs:create", async ({ request, bot }) => {
  const key = readApiIdempotencyKey(request);
  const body = await readJson(request, apiV1CreateRunSchema);
  const { run, created } = await createApiRun(bot, key, body);
  return Response.json(run, { status: created ? 201 : 200 });
});
