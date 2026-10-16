import { version } from "../../../package.json";
import { getDb } from "../../../lib/db";
import { checkHealth } from "./health";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await checkHealth(getDb(), version);
  return Response.json(health, { status: health.status === "ok" ? 200 : 503 });
}
