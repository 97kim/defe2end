import { z } from "zod";
import { readJson, route } from "../../../../../lib/api";
import { setUserDisabled } from "../../../../../lib/accounts/reset-links";

export const dynamic = "force-dynamic";

/** Disable (signs out everywhere) or enable a user. */
export const PATCH = route<{ id: string }>({ action: "user.disable", resource: "instance" }, async ({ request, params, actor }) => {
  const { disabled } = await readJson(request, z.object({ disabled: z.boolean() }));
  await setUserDisabled({ userId: params.id, disabled, actorId: actor.userId });
  return Response.json({ id: params.id, disabled });
});
