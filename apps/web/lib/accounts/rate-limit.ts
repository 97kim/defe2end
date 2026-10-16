import { randomBytes } from "node:crypto";
import { getIP } from "better-auth/api";
import { getAuth } from "../auth";
import { getDb } from "../db";

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

/**
 * Per-IP fixed-window limit for the public link APIs (/api/invite, /api/reset), which Better Auth's own
 * limiter doesn't cover. Shares Better Auth's `rateLimit` table under a `defe2end:` key prefix
 * (`lastRequest` holds the window start). The client IP comes from Better Auth's `getIP`, so proxies and
 * IPv6 subnets are treated the same as for sign-in; like Better Auth, no limit applies when no IP is known.
 * Returns a 429 response when over the limit, otherwise null.
 */
export async function limitPublicRequest(request: Request, scope: "invite" | "reset"): Promise<Response | null> {
  const ip = getIP(request, (await getAuth().$context).options);
  if (!ip) return null;
  const key = `defe2end:${scope}:${ip}`;
  const now = Date.now();
  const windowStart = BigInt(now - WINDOW_MS);
  const [row] = await getDb().$queryRaw<{ count: number; lastRequest: bigint }[]>`
    INSERT INTO "rateLimit" (id, key, count, "lastRequest") VALUES (${randomBytes(12).toString("hex")}, ${key}, 1, ${BigInt(now)})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN "rateLimit"."lastRequest" <= ${windowStart} THEN 1 ELSE "rateLimit".count + 1 END,
      "lastRequest" = CASE WHEN "rateLimit"."lastRequest" <= ${windowStart} THEN ${BigInt(now)} ELSE "rateLimit"."lastRequest" END
    RETURNING count, "lastRequest"`;
  if (!row || row.count <= MAX_PER_WINDOW) return null;
  const retryAfter = Math.max(1, Math.ceil((Number(row.lastRequest) + WINDOW_MS - now) / 1000));
  return Response.json(
    { error: { code: "rate_limited", message: "Too many requests. Try again in a minute." } },
    { status: 429, headers: { "retry-after": String(retryAfter) } },
  );
}
