import { errorResponse, readJson, toErrorResponse } from "../../../lib/api";
import { completeSetup, isSetupDone, setupInputSchema } from "../../../lib/setup";

export const dynamic = "force-dynamic";

// Public (no session): guarded by the install token instead of route().
export async function POST(request: Request) {
  try {
    if (await isSetupDone()) return errorResponse("not_found", "Not found");
    const result = await completeSetup(await readJson(request, setupInputSchema));
    return Response.json(result, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
