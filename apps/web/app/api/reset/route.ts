import { z } from "zod";
import { readJson } from "../../../lib/api";
import { limitPublicRequest } from "../../../lib/accounts/rate-limit";
import { linkErrorResponse } from "../../../lib/accounts/invites";
import { inspectResetLink, resetInputSchema, useResetLink } from "../../../lib/accounts/reset-links";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("inspect"), token: z.string().min(1).max(200) }),
  z.object({ intent: z.literal("reset"), token: z.string().min(1).max(200) }).extend(resetInputSchema.shape),
]);

/**
 * Public (no session required): guarded by the reset token from the page's `#token=`.
 * - inspect: link state and the account email
 * - reset: sets the new password and signs the user out of every session
 */
export async function POST(request: Request) {
  try {
    const limited = await limitPublicRequest(request, "reset");
    if (limited) return limited;
    const body = await readJson(request, bodySchema);
    if (body.intent === "inspect") return Response.json(await inspectResetLink(body.token));
    return Response.json(await useResetLink(body.token, body.password));
  } catch (err) {
    return linkErrorResponse(err);
  }
}
