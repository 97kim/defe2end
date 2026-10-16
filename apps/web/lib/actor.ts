import type { Actor, Role } from "@defe2end/shared";
import { getAuth } from "./auth";
import { getDb } from "./db";

export interface SessionActor extends Actor {
  user: { id: string; name: string; email: string };
  sessionId: string;
}

/**
 * Session cookie → actor with every membership loaded. Null when signed out or disabled.
 * Use in route handlers (pass `request.headers`) and server components (pass `await headers()`).
 */
export async function getActor(headers: Headers): Promise<SessionActor | null> {
  const session = await getAuth().api.getSession({ headers });
  if (!session) return null;
  const user = await getDb().user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      isInstanceAdmin: true,
      disabledAt: true,
      memberships: { select: { workspaceId: true, role: true } },
    },
  });
  if (!user || user.disabledAt) return null;
  const roles: Record<string, Role> = {};
  for (const m of user.memberships) roles[m.workspaceId] = m.role;
  return {
    userId: user.id,
    isInstanceAdmin: user.isInstanceAdmin,
    roles,
    user: { id: user.id, name: user.name, email: user.email },
    sessionId: session.session.id,
  };
}
