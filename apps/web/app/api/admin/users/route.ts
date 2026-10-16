import { route } from "../../../../lib/api";
import { listUsers } from "../../../../lib/accounts/reset-links";

export const dynamic = "force-dynamic";

/** Every user of the instance (instance admins only). */
export const GET = route({ action: "user.list", resource: "instance" }, async () => {
  return Response.json({ users: await listUsers() });
});
