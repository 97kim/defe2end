import { z } from "zod";
import { readJson } from "../../../lib/api";
import { limitPublicRequest } from "../../../lib/accounts/rate-limit";
import { getActor } from "../../../lib/actor";
import { acceptInviteAsUser, acceptInviteWithNewAccount, inspectInvite, linkErrorResponse, signupInputSchema } from "../../../lib/accounts/invites";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("inspect"), token: z.string().min(1).max(200) }),
  z.object({ intent: z.literal("accept"), token: z.string().min(1).max(200) }),
  z.object({ intent: z.literal("signup"), token: z.string().min(1).max(200) }).extend(signupInputSchema.shape),
]);

/**
 * Public (no session required): guarded by the invite token, which arrives in the body
 * (the page reads it from `#token=`, so it never appears in a URL or log).
 * - inspect: link state and invite details, without consuming it
 * - accept: signed-in user whose email matches the invite joins
 * - signup: signed out; creates an account bound to the invite email and joins
 */
export async function POST(request: Request) {
  try {
    const limited = await limitPublicRequest(request, "invite");
    if (limited) return limited;
    const body = await readJson(request, bodySchema);
    if (body.intent === "inspect") return Response.json(await inspectInvite(body.token));
    if (body.intent === "accept") {
      const actor = await getActor(request.headers);
      if (!actor) return Response.json({ error: { code: "unauthenticated", message: "Sign in required" } }, { status: 401 });
      return Response.json(await acceptInviteAsUser(body.token, actor.user));
    }
    return Response.json(await acceptInviteWithNewAccount(body.token, body), { status: 201 });
  } catch (err) {
    return linkErrorResponse(err);
  }
}

