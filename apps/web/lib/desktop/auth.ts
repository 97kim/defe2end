// Desktop app tokens (stage 4 contract section 3.1). Opaque bearer tokens: only their sha256 is stored, they
// last 7 days, belong to one device (= install × user) and can be revoked. Every desktop API call carries one.
import { createHash, randomBytes } from "node:crypto";
import type { DesktopErrorCode } from "@defe2end/shared";
import { ApiError, toErrorResponse } from "../api";
import { getDb } from "../db";
import { revokeMcpTokens } from "../mcp/auth";

export const DESKTOP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashDesktopToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The server's own origin (`BETTER_AUTH_URL`), which the token exchange's `Origin` must match. */
export function serverOrigin(request: Request): string {
  return new URL(process.env.BETTER_AUTH_URL || request.url).origin;
}

export function originMatches(request: Request): boolean {
  return request.headers.get("origin") === serverOrigin(request);
}

/** Creates (or reuses) the device of (installId, user) and a new token for it. */
export async function issueDesktopToken(input: { userId: string; installId: string; label: string }) {
  const db = getDb();
  const device = await db.desktopDevice.upsert({
    where: { installId_userId: { installId: input.installId, userId: input.userId } },
    create: { installId: input.installId, userId: input.userId, label: input.label },
    update: { label: input.label },
    select: { id: true },
  });
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + DESKTOP_TOKEN_TTL_MS);
  await db.desktopToken.create({ data: { tokenHash: hashDesktopToken(token), userId: input.userId, deviceId: device.id, expiresAt } });
  return { token, userId: input.userId, deviceId: device.id, expiresAt: expiresAt.toISOString() };
}

/** Revokes every live token of the user (web sign-out, account disabled). */
export async function revokeUserDesktopTokens(userId: string, db: Parameters<typeof revokeMcpTokens>[0] = getDb()): Promise<number> {
  const { count } = await db.desktopToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  // The app's MCP tokens go with them (stage 6 contract section 3).
  await revokeMcpTokens(db, { userId });
  return count;
}

export interface DesktopPrincipal {
  tokenHash: string;
  userId: string;
  deviceId: string;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match ? match[1]! : null;
}

/** Token → principal when not revoked, not expired, its user active and its device the user's. */
export async function verifyDesktopToken(token: string | null): Promise<DesktopPrincipal | null> {
  if (!token) return null;
  const tokenHash = hashDesktopToken(token);
  const row = await getDb().desktopToken.findUnique({
    where: { tokenHash },
    select: { userId: true, deviceId: true, expiresAt: true, revokedAt: true, user: { select: { disabledAt: true } }, device: { select: { userId: true } } },
  });
  if (!row || row.revokedAt || row.expiresAt <= new Date() || row.user.disabledAt || row.device.userId !== row.userId) return null;
  return { tokenHash, userId: row.userId, deviceId: row.deviceId };
}

/** Desktop API error body: top level `{ code, … }` (desktop-protocol.ts), not the web `{ error }` envelope. */
export function desktopError(status: number, code: DesktopErrorCode | "unauthenticated" | "not_found" | "invalid_request" | "payload_too_large", extra: Record<string, unknown> = {}): Response {
  return Response.json({ code, ...extra }, { status });
}

export class DesktopHttpError extends Error {
  constructor(readonly response: Response) {
    super(`desktop ${response.status}`);
  }
}

/** Wraps a bearer-token desktop handler: 401 without a valid token, thrown `DesktopHttpError`s become responses. */
export function desktopRoute<P extends Record<string, string>>(
  handler: (ctx: { request: Request; params: P; principal: DesktopPrincipal }) => Promise<Response>,
) {
  const wrapped = async (request: Request, context: { params: Promise<P> }) => {
    try {
      const principal = await verifyDesktopToken(bearerToken(request));
      if (!principal) return desktopError(401, "unauthenticated");
      return await handler({ request, params: await context.params, principal });
    } catch (err) {
      if (err instanceof DesktopHttpError) return err.response;
      // Shared services throw the web error; the app reads the desktop shape (top-level `{ code, … }`).
      if (err instanceof ApiError) {
        const res = toErrorResponse(err);
        return Response.json((await res.json()).error, { status: res.status });
      }
      if ((err as { name?: string }).name === "ZodError") return desktopError(400, "invalid_request", { message: (err as Error).message });
      console.error("desktop API failed", err);
      return Response.json({ code: "internal" }, { status: 500 });
    }
  };
  return Object.assign(wrapped, { desktopAuth: true as const });
}
