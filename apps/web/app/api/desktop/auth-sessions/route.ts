import { authSessionRegisterSchema, saveAuthSession } from "../../../../lib/auth-sessions";
import { desktopRoute } from "../../../../lib/desktop/auth";

export const dynamic = "force-dynamic";

/** Registers the app's captured login session; the owner is the token's user (stage 4 contract section 5). */
export const POST = desktopRoute(async ({ request, principal }) => {
  const body = authSessionRegisterSchema.parse(await request.json());
  return Response.json(await saveAuthSession(principal.userId, body), { status: 201 });
});
