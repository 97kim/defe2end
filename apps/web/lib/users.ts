import { getAuth } from "./auth";

/**
 * Creates an email+password user. Public sign-up is off, so setup, invite acceptance
 * and tests create accounts through here.
 */
export async function createPasswordUser(input: {
  email: string;
  name: string;
  password: string;
  isInstanceAdmin?: boolean;
}): Promise<{ id: string; email: string }> {
  const ctx = await getAuth().$context;
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  if (input.password.length < minPasswordLength || input.password.length > maxPasswordLength) {
    throw new Error(`Password must be ${minPasswordLength}–${maxPasswordLength} characters`);
  }
  const hash = await ctx.password.hash(input.password);
  const user = await ctx.internalAdapter.createUser(
    {
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      emailVerified: false,
      isInstanceAdmin: input.isInstanceAdmin ?? false,
    },
    { method: "email-password" },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: hash,
  });
  return { id: user.id, email: user.email };
}
