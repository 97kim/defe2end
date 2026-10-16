import { randomBytes } from "node:crypto";
import type { Prisma } from "@defe2end/db";
import { ApiError } from "../api";
import { getAuth } from "../auth";

/** Validates and hashes a password with Better Auth's settings. Do it before opening a transaction (it's slow). */
export async function hashNewPassword(password: string): Promise<string> {
  const ctx = await getAuth().$context;
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  if (password.length < minPasswordLength || password.length > maxPasswordLength) {
    throw new ApiError("invalid_request", `Password must be ${minPasswordLength}–${maxPasswordLength} characters`);
  }
  return ctx.password.hash(password);
}

/**
 * Inserts an email+password user inside the caller's transaction, so it commits or rolls back
 * together with whatever else that step creates (membership, workspace, used token).
 */
export async function insertPasswordUser(
  tx: Prisma.TransactionClient,
  input: { email: string; name: string; isInstanceAdmin?: boolean },
  passwordHash: string,
): Promise<{ id: string; email: string }> {
  const id = randomBytes(16).toString("hex");
  const user = await tx.user.create({
    data: { id, email: input.email.trim().toLowerCase(), name: input.name.trim(), emailVerified: false, isInstanceAdmin: input.isInstanceAdmin ?? false },
  });
  await tx.account.create({
    data: { id: randomBytes(16).toString("hex"), providerId: "credential", accountId: id, userId: id, password: passwordHash },
  });
  return { id: user.id, email: user.email };
}
