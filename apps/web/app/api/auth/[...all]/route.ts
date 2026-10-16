import { getAuth } from "../../../../lib/auth";
import { revokeUserDesktopTokens } from "../../../../lib/desktop/auth";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return getAuth().handler(request);
}

/** A web sign-out also revokes the user's desktop tokens (stage 4 contract section 9). */
export async function POST(request: Request) {
  if (!new URL(request.url).pathname.endsWith("/sign-out")) return getAuth().handler(request);
  const session = await getAuth().api.getSession({ headers: request.headers }).catch(() => null);
  const response = await getAuth().handler(request);
  if (session && response.ok) await revokeUserDesktopTokens(session.user.id);
  return response;
}
