import { can, isWorkspaceAction, type Action, type ResourceType } from "@defe2end/shared";
import type { Workspace } from "@defe2end/db";
import { ZodError } from "zod";
import { getActor, type SessionActor } from "./actor";
import { getDb } from "./db";

export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "idempotency_conflict"
  | "queue_full"
  | "storage_low"
  | "payload_too_large"
  | "desktop_not_connected"
  | "app_update_required"
  | "auth_session_missing"
  | "variable_missing"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  idempotency_conflict: 409,
  queue_full: 429,
  storage_low: 503,
  payload_too_large: 413,
  desktop_not_connected: 409,
  app_update_required: 409,
  auth_session_missing: 409,
  variable_missing: 409,
  internal: 500,
};

/** Throw from a handler to answer `{ error: { code, message } }` with the matching status. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Extra fields of the error body (e.g. `missing` of `app_update_required`). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  /** The wrapper's 404 body. Throw it when an id from the URL or body belongs to another workspace. */
  static notFound(): ApiError {
    return new ApiError("not_found", NOT_FOUND_MESSAGE);
  }
}

export function errorResponse(code: ErrorCode, message: string, details?: Record<string, unknown>): Response {
  return Response.json({ error: { code, message, ...details } }, { status: STATUS[code] });
}

/** Maps a thrown error to the API error format; unknown errors are logged and hidden. */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof ApiError) return errorResponse(err.code, err.message, err.details);
  if (err instanceof ZodError) return errorResponse("invalid_request", err.issues.map((i) => i.message).join("; "));
  console.error("API route failed", err);
  return errorResponse("internal", "Internal error");
}

// Same body for "no such workspace" and "not a member": existence must not leak.
const NOT_FOUND_MESSAGE = "Not found";

type Params = Record<string, string | string[] | undefined>;

export interface RouteContext<P extends Params> {
  request: Request;
  params: P;
  actor: SessionActor;
  /** Set for workspace routes (`/api/w/[slug]/…`); permission already checked. */
  workspace: Workspace;
}

export interface InstanceRouteContext<P extends Params> {
  request: Request;
  params: P;
  actor: SessionActor;
}

export interface RouteSpec {
  action: Action;
  resource: ResourceType;
}

type NextHandler = ((request: Request, context: { params: Promise<any> }) => Promise<Response>) & {
  /** Read by the route inventory test. */
  routeSpec: RouteSpec;
  /** The handler after authentication; `/api/mcp/*` re-exposes it with MCP token authentication. */
  inner: (ctx: RouteContext<any>) => Promise<Response> | Response;
};

/**
 * The only way to write an authenticated API route.
 * Order: session → actor → workspace by `[slug]` → `can()` → handler.
 * Signed out → 401, unknown workspace or not a member → 404, role too low → 403.
 */
export function route<P extends Params = { slug: string }>(
  spec: RouteSpec & { resource: Exclude<ResourceType, "instance"> },
  handler: (ctx: RouteContext<P>) => Promise<Response> | Response,
): NextHandler;
export function route<P extends Params = Params>(
  spec: RouteSpec & { resource: "instance" },
  handler: (ctx: InstanceRouteContext<P>) => Promise<Response> | Response,
): NextHandler;
export function route(
  spec: RouteSpec,
  handler: (ctx: RouteContext<Params>) => Promise<Response> | Response,
): NextHandler {
  if ((spec.resource === "instance") === isWorkspaceAction(spec.action)) {
    throw new Error(`route(): action ${spec.action} does not fit resource ${spec.resource}`);
  }
  const wrapped = async (request: Request, context: { params: Promise<Params> }) => {
    try {
      const params = await context.params;
      // MCP tokens open `/api/mcp/*` only (stage 6 contract section 3), never a session route.
      if (MCP_BEARER.test(request.headers.get("authorization") ?? "")) return errorResponse("forbidden", "MCP tokens work on /api/mcp only");
      const actor = await getActor(request.headers);
      if (!actor) return errorResponse("unauthenticated", "Sign in required");
      return await runAs(spec, handler, request, params, actor);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
  return Object.assign(wrapped, { routeSpec: spec, inner: handler });
}

const MCP_BEARER = /^Bearer\s+mcp_/i;

/**
 * The checks after authentication, shared by session routes and `/api/mcp/*` (same handler, same `can()`):
 * workspace by `[slug]` → `can()` → handler. Unknown workspace or not a member → 404, role too low → 403.
 */
export async function runAs(spec: RouteSpec, handler: (ctx: RouteContext<Params>) => Promise<Response> | Response, request: Request, params: Params, actor: SessionActor): Promise<Response> {
  if (spec.resource === "instance") {
    if (can(actor, spec.action, { type: "instance" }) !== "allow") return errorResponse("forbidden", "Forbidden");
    return await handler({ request, params, actor } as RouteContext<Params>);
  }
  const slug = params.slug;
  if (typeof slug !== "string") throw new Error("Workspace routes must live under a [slug] segment");
  const workspace = await getDb().workspace.findUnique({ where: { slug } });
  if (!workspace) return errorResponse("not_found", NOT_FOUND_MESSAGE);
  const decision = can(actor, spec.action, { type: spec.resource, workspaceId: workspace.id });
  if (decision === "not_found") return errorResponse("not_found", NOT_FOUND_MESSAGE);
  if (decision === "forbidden") return errorResponse("forbidden", "Your role does not allow this");
  return await handler({ request, params, actor, workspace });
}

/** Parses a JSON body with a zod schema; failures become 400 `invalid_request`. */
export async function readJson<T>(request: Request, schema: { parse(value: unknown): T }): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError("invalid_request", "Body must be JSON");
  }
  return schema.parse(body);
}
