// Every write to Membership or User.disabledAt must take the shared admin-membership lock first.
// Two checks: each known path really waits on the lock (behaviour), and no source file writes
// those without calling the lock helper (so a future path can't quietly skip it).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDbClient } from "@defe2end/db";
import { beforeEach, expect, it } from "vitest";
import { describeDb, resetDatabase } from "../../test/db";
import { addMember, callRoute, createUser, createWorkspace, sessionHeaders } from "../../test/helpers";
import * as adminUser from "../../app/api/admin/users/[id]/route";
import * as resetLinkRoute from "../../app/api/admin/users/[id]/reset-link/route";
import * as member from "../../app/api/w/[slug]/members/[id]/route";
import * as workspacesRoute from "../../app/api/workspaces/route";
import { createAdminCommand } from "../../cli/defe2end.mjs";
import { getDb } from "../db";
import { completeSetup } from "../setup";
import { issueInstallToken } from "../startup";
import { createWorkspaceFor } from "../workspaces";
import { ADMIN_MEMBERSHIP_LOCK } from "./admin-lock";
import { acceptInviteAsUser, createInvite } from "./invites";
import { changeRole, removeMember } from "./members";
import { setUserDisabled } from "./reset-links";

const WEB_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Takes the lock on its own connection. Under load, getting a connection can outlast Prisma's 2 s default
 * `maxWait`; the race makes that a test error instead of an `isLocked` that never comes.
 */
async function holdLock() {
  const holder = createDbClient();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const holding = holder.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_MEMBERSHIP_LOCK}::bigint)`;
      locked();
      await held;
    },
    { maxWait: 15_000, timeout: 30_000 },
  );
  await Promise.race([isLocked, holding]);
  return {
    async release() {
      release();
      await holding;
      await holder.$disconnect();
    },
  };
}

/** Sessions waiting for the lock right now (a bigint advisory key shows as classid/objid with objsubid 1). */
async function lockWaiters(): Promise<number> {
  const [row] = await getDb().$queryRaw<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting FROM pg_locks
    WHERE locktype = 'advisory' AND objsubid = 1 AND NOT granted
      AND (classid::bigint << 32 | objid::bigint) = ${ADMIN_MEMBERSHIP_LOCK}::bigint`;
  return row?.waiting ?? 0;
}

/** Resolves once `count` sessions wait for the lock, or `done()` says the operation already ended. */
async function untilWaiting(count: number, done: () => boolean = () => false) {
  while (!done() && (await lockWaiters()) < count) await new Promise((r) => setTimeout(r, 20));
}

/**
 * Runs `op` while another connection holds the lock: it must not finish until the lock is released.
 * No fixed sleep: it waits until `op` is seen queued on the lock (or has finished, which is the failure).
 */
async function waitsForLock(op: () => Promise<unknown>) {
  const lock = await holdLock();
  let settled = false;
  const running = op().finally(() => (settled = true));
  await untilWaiting(1, () => settled);
  const finishedWhileLocked = settled;
  await lock.release();
  await running;
  return finishedWhileLocked;
}

describeDb("admin-membership lock: every path waits for it", () => {
  beforeEach(resetDatabase);

  async function workspace() {
    const ws = await createWorkspace();
    const a = await createUser();
    const b = await createUser();
    const am = await addMember(a.id, ws.id, "ADMIN");
    const bm = await addMember(b.id, ws.id, "ADMIN");
    return { ws, a, b, am, bm };
  }

  it("role change", async () => {
    const { ws, a, bm } = await workspace();
    expect(await waitsForLock(() => changeRole({ workspaceId: ws.id, membershipId: bm.id, role: "EDITOR", actorId: a.id }))).toBe(false);
  });

  it("member remove", async () => {
    const { ws, a, bm } = await workspace();
    expect(await waitsForLock(() => removeMember({ workspaceId: ws.id, membershipId: bm.id, actorId: a.id }))).toBe(false);
  });

  it("user disable and enable", async () => {
    const { b } = await workspace();
    const root = await createUser({ isInstanceAdmin: true });
    expect(await waitsForLock(() => setUserDisabled({ userId: b.id, disabled: true, actorId: root.id }))).toBe(false);
    expect(await waitsForLock(() => setUserDisabled({ userId: b.id, disabled: false, actorId: root.id }))).toBe(false);
  });

  it("invite accept", async () => {
    const { ws, a } = await workspace();
    const invitee = await createUser({ email: "lock@example.com" });
    const { token } = await createInvite({ workspaceId: ws.id, email: invitee.email, role: "VIEWER", actorId: a.id });
    expect(await waitsForLock(() => acceptInviteAsUser(token, invitee))).toBe(false);
  });

  it("workspace create", async () => {
    const root = await createUser({ isInstanceAdmin: true });
    expect(await waitsForLock(() => createWorkspaceFor(root.id, "Locked"))).toBe(false);
  });

  it("setup and CLI create-admin", async () => {
    const token = (await issueInstallToken(getDb()))!;
    const input = { token, name: "Admin", email: "first@example.com", password: "a long password", workspaceName: "First" };
    expect(await waitsForLock(() => completeSetup(input))).toBe(false);
    await resetDatabase();
    const cli = createDbClient();
    expect(await waitsForLock(() => createAdminCommand(cli, "cli@example.com"))).toBe(false);
    await cli.$disconnect();
  });
});

describeDb("the acting user is re-checked after the lock", () => {
  beforeEach(resetDatabase);

  /** Holds the lock, starts `first` then `second` (both queue on it, in that order), then releases. */
  async function queued(first: () => Promise<Response>, second: () => Promise<Response>) {
    const lock = await holdLock();
    const a = first();
    await untilWaiting(1);
    const b = second();
    await untilWaiting(2);
    await lock.release();
    return Promise.all([a, b]);
  }

  it("an instance admin disabled while waiting can't create a workspace", async () => {
    const root = await createUser({ isInstanceAdmin: true });
    const b = await createUser({ isInstanceAdmin: true });
    const [rootH, bH] = [await sessionHeaders(root.id), await sessionHeaders(b.id)];
    const [disable, create] = await queued(
      () => callRoute(adminUser.PATCH, { method: "PATCH", params: { id: b.id }, body: { disabled: true }, headers: rootH }),
      () => callRoute(workspacesRoute.POST, { method: "POST", body: { name: "Late Shop" }, headers: bH }),
    );
    expect(disable.status).toBe(200);
    expect([401, 403]).toContain(create.status);
    expect(await getDb().workspace.count({ where: { name: "Late Shop" } })).toBe(0);
  });

  it("an admin demoted while waiting can't change roles", async () => {
    const ws = await createWorkspace();
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    await addMember(a.id, ws.id, "ADMIN");
    const bm = await addMember(b.id, ws.id, "ADMIN");
    const cm = await addMember(c.id, ws.id, "EDITOR");
    const [aH, bH] = [await sessionHeaders(a.id), await sessionHeaders(b.id)];
    const [demoteB, promoteC] = await queued(
      () => callRoute(member.PATCH, { method: "PATCH", params: { slug: ws.slug, id: bm.id }, body: { role: "EDITOR" }, headers: aH }),
      () => callRoute(member.PATCH, { method: "PATCH", params: { slug: ws.slug, id: cm.id }, body: { role: "ADMIN" }, headers: bH }),
    );
    expect(demoteB.status).toBe(200);
    expect(promoteC.status).toBe(403);
    expect((await getDb().membership.findUniqueOrThrow({ where: { id: cm.id } })).role).toBe("EDITOR");
  });

  it("an admin disabled while waiting can't change roles", async () => {
    const ws = await createWorkspace();
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    await addMember(a.id, ws.id, "ADMIN");
    await addMember(b.id, ws.id, "ADMIN");
    const cm = await addMember(c.id, ws.id, "EDITOR");
    const root = await createUser({ isInstanceAdmin: true });
    const [rootH, bH] = [await sessionHeaders(root.id), await sessionHeaders(b.id)];
    const [disable, promoteC] = await queued(
      () => callRoute(adminUser.PATCH, { method: "PATCH", params: { id: b.id }, body: { disabled: true }, headers: rootH }),
      () => callRoute(member.PATCH, { method: "PATCH", params: { slug: ws.slug, id: cm.id }, body: { role: "ADMIN" }, headers: bH }),
    );
    expect(disable.status).toBe(200);
    expect(promoteC.status).toBe(401);
    expect((await getDb().membership.findUniqueOrThrow({ where: { id: cm.id } })).role).toBe("EDITOR");
  });

  it("an instance admin disabled while waiting can't issue a reset link", async () => {
    const root = await createUser({ isInstanceAdmin: true });
    const b = await createUser({ isInstanceAdmin: true });
    const target = await createUser();
    const [rootH, bH] = [await sessionHeaders(root.id), await sessionHeaders(b.id)];
    const [disable, issue] = await queued(
      () => callRoute(adminUser.PATCH, { method: "PATCH", params: { id: b.id }, body: { disabled: true }, headers: rootH }),
      () => callRoute(resetLinkRoute.POST, { method: "POST", params: { id: target.id }, headers: bH }),
    );
    expect(disable.status).toBe(200);
    expect([401, 403]).toContain(issue.status);
    expect(await getDb().resetLink.count({ where: { userId: target.id } })).toBe(0);
  });
});

it("no source file writes Membership or disabledAt without locking (and re-validating the actor)", () => {
  const WRITES = /\bmembership\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|memberships:\s*\{\s*create|data:\s*\{[^}]*\bdisabledAt\b|\bworkspace\.delete\b/;
  // Paths with a session actor must lock through the re-validating helper. Setup and the CLI have no
  // session actor, so they alone may take the plain lock.
  const REVALIDATED = /\blockAndRevalidateActor\(|\bwithLockedActor\(/;
  const NO_ACTOR: Record<string, RegExp> = {
    "lib/setup.ts": /\blockAdminMembership\(/,
    "cli/defe2end.mjs": /pg_advisory_xact_lock\(\$\{ADMIN_MEMBERSHIP_LOCK\}/,
  };
  const files = ["app", "lib", "cli"].flatMap((dir) =>
    readdirSync(`${WEB_ROOT}/${dir}`, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.ts$|\.d\.mts$|(^|\/)testing\//.test(f))
      .map((f) => `${dir}/${f}`),
  );
  const offenders = files.filter((f) => {
    const src = readFileSync(`${WEB_ROOT}/${f}`, "utf8");
    if (!WRITES.test(src)) return false;
    return !(NO_ACTOR[f] ?? REVALIDATED).test(src);
  });
  // Nobody else may take the plain lock (it would skip the actor re-check).
  const plainLockUsers = files.filter(
    (f) => !(f in NO_ACTOR) && f !== "lib/accounts/admin-lock.ts" && /\blockAdminMembership\(/.test(readFileSync(`${WEB_ROOT}/${f}`, "utf8")),
  );
  expect(plainLockUsers).toEqual([]);
  expect(offenders).toEqual([]);
  // Issuing a reset link hands out a token for another account, so it must re-validate the issuer too.
  // reset-links.ts locks elsewhere in the file, so check the function body itself.
  const resetSrc = readFileSync(`${WEB_ROOT}/lib/accounts/reset-links.ts`, "utf8");
  const issueBody = resetSrc.slice(resetSrc.indexOf("export async function issueResetLink"), resetSrc.indexOf("export async function inspectResetLink"));
  expect(issueBody).toMatch(/\bresetLink\.create\b/);
  expect(issueBody).toMatch(/withLockedActor\([^,]+,\s*\{\s*kind:\s*"instanceAdmin"\s*\}|lockAndRevalidateActor\(tx,[^,]+,\s*\{\s*kind:\s*"instanceAdmin"\s*\}/);
  const resetIssuers = files.filter((f) => f !== "cli/defe2end.mjs" && /\bresetLink\.create\b/.test(readFileSync(`${WEB_ROOT}/${f}`, "utf8")));
  expect(resetIssuers).toEqual(["lib/accounts/reset-links.ts"]);
  // The scan must actually see the known writers, or the regex has rotted.
  const writers = files.filter((f) => WRITES.test(readFileSync(`${WEB_ROOT}/${f}`, "utf8")));
  expect(writers).toEqual(
    expect.arrayContaining(["lib/accounts/members.ts", "lib/accounts/reset-links.ts", "lib/accounts/invites.ts", "lib/setup.ts", "lib/workspaces.ts", "app/api/w/[slug]/route.ts", "cli/defe2end.mjs"]),
  );
});
