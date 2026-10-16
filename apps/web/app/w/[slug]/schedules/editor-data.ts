import { getDb } from "../../../../lib/db";

/** What the editor offers: environments, unarchived scenarios and tags of the workspace. */
export async function editorOptions(workspaceId: string) {
  const db = getDb();
  const [environments, scenarios, tags] = await Promise.all([
    db.environment.findMany({ where: { workspaceId }, select: { id: true, name: true, siteId: true, site: { select: { name: true } } }, orderBy: [{ site: { name: "asc" } }, { name: "asc" }] }),
    db.scenario.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true, siteId: true }, orderBy: { name: "asc" } }),
    db.tag.findMany({ where: { workspaceId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return { environments: environments.map((e) => ({ id: e.id, name: e.name, siteId: e.siteId, siteName: e.site.name })), scenarios, tags };
}
export type EditorOptions = Awaited<ReturnType<typeof editorOptions>>;
