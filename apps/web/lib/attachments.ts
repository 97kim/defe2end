// Workspace attachments (`attachment:<name>` tokens of uploadFile steps, contract sections 2 and 7): list, download, delete.
// Upload is the worker team's `POST …/attachments/upload`.
import { ApiError } from "./api";
import { getDb } from "./db";
import { assertNoActiveRuns } from "./run-create";
import { getStorage } from "./storage";

export interface AttachmentVersionView {
  id: string;
  version: number;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  url: string;
}

/** One entry per name, newest version first; `upload` steps use the latest. */
export interface AttachmentView {
  name: string;
  versions: AttachmentVersionView[];
}

export function attachmentUrl(slug: string, id: string): string {
  return `/api/w/${slug}/attachments/${id}`;
}

export async function listAttachments(workspace: { id: string; slug: string }): Promise<AttachmentView[]> {
  const rows = await getDb().attachment.findMany({ where: { workspaceId: workspace.id }, orderBy: [{ name: "asc" }, { version: "desc" }] });
  const byName = new Map<string, AttachmentVersionView[]>();
  for (const r of rows) {
    const list = byName.get(r.name) ?? [];
    list.push({ id: r.id, version: r.version, contentType: r.contentType, sizeBytes: r.sizeBytes, createdAt: r.createdAt.toISOString(), url: attachmentUrl(workspace.slug, r.id) });
    byName.set(r.name, list);
  }
  return [...byName].map(([name, versions]) => ({ name, versions }));
}

export async function findAttachment(workspaceId: string, id: string) {
  const row = await getDb().attachment.findFirst({ where: { id, workspaceId } });
  if (!row) throw ApiError.notFound();
  return row;
}

/**
 * Deletes one version. A queued or running run that pinned this version (`attachment:<name>` in an uploadFile
 * step, snapshot `attachments`) refuses with 409. The file goes after the row; a file left by a failed delete
 * is removed by the worker's orphan sweep.
 */
export async function deleteAttachment(workspaceId: string, id: string): Promise<{ name: string; version: number }> {
  const row = await getDb().$transaction(async (tx) => {
    await assertNoActiveRuns(tx, workspaceId, { snapshot: { path: ["attachments"], array_contains: [{ id }] } });
    const found = await tx.attachment.findFirst({ where: { id, workspaceId } });
    if (!found) throw ApiError.notFound();
    await tx.attachment.delete({ where: { id } });
    return found;
  });
  await getStorage()
    .delete(row.storageKey)
    .catch((err) => console.error("attachment file not deleted", err));
  return { name: row.name, version: row.version };
}

/** `filename*` per RFC 6266/5987, plus an ASCII fallback. The name is display only, never a path. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
