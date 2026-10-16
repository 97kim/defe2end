import { randomUUID } from "node:crypto";
import type { Role } from "@defe2end/shared";
import { makeSignature } from "better-auth/crypto";
import { getAuth } from "../lib/auth";
import { getDb } from "../lib/db";
import { createPasswordUser } from "../lib/users";

export const TEST_PASSWORD = "correct horse battery";

function unique(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export async function createUser(opts: { email?: string; name?: string; isInstanceAdmin?: boolean } = {}) {
  const email = opts.email ?? `${unique("user")}@example.com`;
  return createPasswordUser({
    email,
    name: opts.name ?? email.split("@")[0]!,
    password: TEST_PASSWORD,
    isInstanceAdmin: opts.isInstanceAdmin,
  });
}

export async function createWorkspace(opts: { name?: string; slug?: string } = {}) {
  const slug = opts.slug ?? unique("ws");
  return getDb().workspace.create({ data: { name: opts.name ?? slug, slug } });
}

export async function addMember(userId: string, workspaceId: string, role: Role) {
  return getDb().membership.create({ data: { userId, workspaceId, role } });
}

/** Request headers carrying a real, signed session cookie for `userId`. */
export async function sessionHeaders(userId: string): Promise<Headers> {
  const ctx = await getAuth().$context;
  const session = await ctx.internalAdapter.createSession(userId);
  const signed = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;
  return new Headers({ cookie: `${ctx.authCookies.sessionToken.name}=${signed}` });
}

/** A workspace with one member per role, plus an outsider who is admin of another workspace. */
export async function workspaceWithRoles() {
  const workspace = await createWorkspace();
  const other = await createWorkspace();
  const users = {
    ADMIN: await createUser(),
    EDITOR: await createUser(),
    VIEWER: await createUser(),
    OUTSIDER: await createUser(),
  };
  await addMember(users.ADMIN.id, workspace.id, "ADMIN");
  await addMember(users.EDITOR.id, workspace.id, "EDITOR");
  await addMember(users.VIEWER.id, workspace.id, "VIEWER");
  await addMember(users.OUTSIDER.id, other.id, "ADMIN");
  return { workspace, other, users };
}

type Handler = (request: Request, context: { params: Promise<any> }) => Promise<Response> | Response;

/** Calls a route handler like Next.js would. `headers` usually comes from `sessionHeaders()`. */
export async function callRoute(
  handler: Handler,
  opts: { method?: string; path?: string; params?: Record<string, string | string[]>; headers?: Headers; body?: unknown } = {},
): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`http://localhost:3000${opts.path ?? "/"}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return handler(request, { params: Promise.resolve(opts.params ?? {}) });
}
