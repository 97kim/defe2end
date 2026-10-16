#!/usr/bin/env node
// Emergency account recovery for server operators (contract section 5). Runs inside the web container:
//   docker compose exec web defe2end admin reset-link --email <addr>
//   docker compose exec web defe2end admin create-admin --email <addr>
// Prints a one-time /reset#token=… link to stdout. Plain JS so it runs from the standalone image without a build step;
// the reset-link logic mirrors lib/accounts/reset-links.ts (same token hashing, lifetime, revocation and audit).
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createDbClient } from "@defe2end/db";
import { generateLinkToken, hashLinkToken, LINK_TOKEN_TTL_MS } from "@defe2end/shared/server";

const USAGE = `Usage:
  defe2end admin reset-link --email <addr>     Print a one-time password reset link (valid 1 hour)
  defe2end admin create-admin --email <addr>   Create the first instance admin (only when none exists) and print a link to set its password`;

export class CliError extends Error {}

/** The shared admin-membership lock; keep in sync with ADMIN_MEMBERSHIP_LOCK in lib/accounts/admin-lock.ts. */
export const ADMIN_MEMBERSHIP_LOCK = 1684366642;

function baseUrl() {
  return (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** @param {import("@defe2end/db").PrismaClient} db */
async function issueResetLink(db, userId, action) {
  const token = generateLinkToken();
  await db.$transaction(async (tx) => {
    await tx.resetLink.updateMany({ where: { userId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.resetLink.create({
      data: { userId, tokenHash: hashLinkToken(token), expiresAt: new Date(Date.now() + LINK_TOKEN_TTL_MS.reset), createdById: null },
    });
    await tx.auditLog.create({ data: { actorId: null, action, targetType: "user", targetId: userId, meta: { via: "cli" } } });
  });
  return `${baseUrl()}/reset#token=${token}`;
}

/** @param {import("@defe2end/db").PrismaClient} db */
export async function resetLinkCommand(db, email) {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) throw new CliError(`No user with email ${email}`);
  return issueResetLink(db, user.id, "user.reset_link.issue");
}

/** @param {import("@defe2end/db").PrismaClient} db */
export async function createAdminCommand(db, email) {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) throw new CliError(`Not an email address: ${email}`);
  const userId = await db.$transaction(async (tx) => {
    // The shared admin-membership lock (lib/accounts/admin-lock.ts), also taken by web setup: with no admin
    // yet there are no rows to lock, and this may re-enable a user (writes disabledAt).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_MEMBERSHIP_LOCK}::bigint)`;
    if ((await tx.user.count({ where: { isInstanceAdmin: true } })) > 0) throw new CliError("An instance admin already exists. Use `defe2end admin reset-link --email <addr>` instead.");
    const existing = await tx.user.findUnique({ where: { email: normalized } });
    const user = existing
      ? await tx.user.update({ where: { id: existing.id }, data: { isInstanceAdmin: true, disabledAt: null } })
      : await tx.user.create({
          data: { id: randomBytes(16).toString("hex"), email: normalized, name: normalized.split("@")[0], isInstanceAdmin: true },
        });
    await tx.auditLog.create({ data: { actorId: null, action: "user.create_admin", targetType: "user", targetId: user.id, meta: { via: "cli" } } });
    return user.id;
  });
  // No password yet: the reset link sets one.
  return issueResetLink(db, userId, "user.reset_link.issue");
}

function parseEmail(args) {
  const i = args.indexOf("--email");
  const value = i >= 0 ? args[i + 1] : args.find((a) => a.startsWith("--email="))?.slice("--email=".length);
  if (!value) throw new CliError(`--email is required\n\n${USAGE}`);
  return value;
}

export async function main(argv = process.argv.slice(2), injectedDb) {
  const [group, command, ...rest] = argv;
  let db = injectedDb;
  try {
    if (group !== "admin" || !["reset-link", "create-admin"].includes(command ?? "")) throw new CliError(USAGE);
    const email = parseEmail(rest);
    db ??= createDbClient();
    const link = command === "reset-link" ? await resetLinkCommand(db, email) : await createAdminCommand(db, email);
    process.stdout.write(`${link}\n`);
    process.stderr.write("One-time link, valid for 1 hour. Using it signs that user out everywhere.\n");
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof CliError ? err.message : `defe2end: ${err instanceof Error ? err.message : String(err)}`}\n`);
    return 1;
  } finally {
    await db?.$disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
