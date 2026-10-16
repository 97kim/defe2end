import { z } from "zod";
import { readJson, route } from "../../../../../lib/api";
import { getDb } from "../../../../../lib/db";
import { tagNameSchema } from "../../../../../lib/scenario-helpers";
import { upsertTag } from "../../../../../lib/scenarios";

export const dynamic = "force-dynamic";

/** Workspace tags with how many scenarios use each. */
export const GET = route({ action: "workspace.read", resource: "tag" }, async ({ workspace }) => {
  const tags = await getDb().tag.findMany({
    where: { workspaceId: workspace.id },
    select: { id: true, name: true, _count: { select: { scenarios: true } } },
    orderBy: { name: "asc" },
  });
  return Response.json({ tags: tags.map((t) => ({ id: t.id, name: t.name, scenarioCount: t._count.scenarios })) });
});

/** Get-or-create by name (names are unique per workspace). */
export const POST = route({ action: "scenario.write", resource: "tag" }, async ({ request, workspace }) => {
  const body = await readJson(request, z.strictObject({ name: tagNameSchema }));
  const tag = await upsertTag(workspace.id, body.name);
  return Response.json({ id: tag.id, name: tag.name });
});
