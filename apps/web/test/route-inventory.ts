import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RouteSpec } from "../lib/api";

const APP_DIR = fileURLToPath(new URL("../app", import.meta.url));
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export interface RouteEntry {
  /** e.g. `/api/w/[slug]/scenarios/[id]` */
  path: string;
  method: (typeof METHODS)[number];
  handler: (request: Request, context: { params: Promise<any> }) => Promise<Response>;
  /** Present when the handler was built with `route()`. */
  spec?: RouteSpec;
  /** Dynamic segments; catch-all ones (`[...x]`) take arrays. */
  params: { name: string; catchAll: boolean }[];
}

/** Every exported HTTP method of every `route.ts` under app/api, found on disk. */
export async function collectRoutes(): Promise<RouteEntry[]> {
  const files = readdirSync(`${APP_DIR}/api`, { recursive: true, encoding: "utf8" })
    .filter((f) => /(^|\/)route\.ts$/.test(f))
    .sort();
  const entries: RouteEntry[] = [];
  for (const file of files) {
    const dir = file.replace(/\/?route\.ts$/, "");
    const path = `/api${dir ? `/${dir}` : ""}`;
    const params = [...path.matchAll(/\[(\.\.\.)?([^\]]+)\]/g)].map((m) => ({ name: m[2]!, catchAll: Boolean(m[1]) }));
    const mod = (await import(`${APP_DIR}/api/${file}`)) as Record<string, unknown>;
    for (const method of METHODS) {
      const handler = mod[method] as (RouteEntry["handler"] & { routeSpec?: RouteSpec }) | undefined;
      if (handler) entries.push({ path, method, handler, spec: handler.routeSpec, params });
    }
  }
  return entries;
}

/** Fills dynamic segments: `slug` from the caller, everything else a dummy id. */
export function fillParams(entry: RouteEntry, slug: string): Record<string, string | string[]> {
  return Object.fromEntries(entry.params.map((p) => [p.name, p.name === "slug" ? slug : p.catchAll ? ["x"] : "x"]));
}

export function urlFor(entry: RouteEntry, params: Record<string, string | string[]>): string {
  return entry.path.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, (_, name: string) => [params[name] ?? "x"].flat().join("/"));
}
