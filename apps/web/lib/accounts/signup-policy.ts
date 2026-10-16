import { getDb } from "../db";

/**
 * May an external sign-in (OIDC, GitHub) create a new user with this email? Contract section 1 and plan 4.6:
 * only a verified email, and only if it has a valid pending invite or its domain is on the instance's
 * self-signup list (empty by default). Enforced in Better Auth's user-create hook, so request flags like
 * `requestSignUp` can't get around it.
 */
export async function externalSignupAllowed(user: { email?: string | null; emailVerified?: boolean | null }): Promise<boolean> {
  if (user.emailVerified !== true || !user.email) return false;
  const email = user.email.trim().toLowerCase();
  const db = getDb();
  const invite = await db.invite.findFirst({
    where: { email, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (invite) return true;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const setting = await db.instanceSetting.findUnique({ where: { id: 1 }, select: { selfSignupDomains: true } });
  return (setting?.selfSignupDomains ?? []).some((d) => d.trim().toLowerCase() === domain);
}
