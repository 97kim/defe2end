// Attachment uploads (stage 3 contract sections 3 and 7): the file goes to storage under a server-made key,
// then the row is added under a per-workspace lock that re-checks the workspace total, so concurrent uploads
// can't pass the limit together. A file whose row isn't added is deleted again.
import { ATTACHMENT_WORKSPACE_LOCK_SPACE } from "@defe2end/db";
import { attachmentNameIssue } from "@defe2end/shared";
import { attachmentKey, StorageFullError } from "@defe2end/shared/server";
import { z } from "zod";
import { ApiError } from "./api";
import { getDb } from "./db";
import { getStorage, minFreeDiskBytes } from "./storage";

const MB = 1024 * 1024;

/** `ATTACHMENT_MAX_MB` (default 20) per file, `ATTACHMENT_WORKSPACE_MAX_MB` (default 500) per workspace. */
export function attachmentLimits(env: NodeJS.ProcessEnv = process.env): { fileBytes: number; workspaceBytes: number } {
  return { fileBytes: Number(env.ATTACHMENT_MAX_MB || 20) * MB, workspaceBytes: Number(env.ATTACHMENT_WORKSPACE_MAX_MB || 500) * MB };
}

/** What `upload` steps refer to. Shown and matched as is; never used as a path. */
export const attachmentNameSchema = z
  .string()
  .trim()
  .superRefine((name, ctx) => {
    const issue = attachmentNameIssue(name);
    if (issue) ctx.addIssue({ code: "custom", message: issue });
  });

class TooLarge extends Error {}

const tooLarge = (limit: number, what: string) =>
  new ApiError("payload_too_large", `${what} is over the ${Math.round(limit / MB)} MB limit`);

export interface StoredAttachment {
  id: string;
  name: string;
  version: number;
  contentType: string;
  sizeBytes: number;
}

/** Stores a new version of `name` (the first is 1). 413 over the file or workspace limit, 503 when storage is low. */
export async function storeAttachment(input: {
  workspaceId: string;
  name: string;
  contentType: string;
  body: AsyncIterable<Uint8Array>;
}): Promise<StoredAttachment> {
  const { workspaceId } = input;
  const limits = attachmentLimits();
  const storage = getStorage();
  if ((await storage.freeBytes()) < minFreeDiskBytes()) {
    throw new ApiError("storage_low", "The server is low on storage space, so uploads are paused. Ask an administrator.");
  }
  const counted = async function* () {
    let total = 0;
    for await (const chunk of input.body) {
      total += chunk.byteLength;
      if (total > limits.fileBytes) throw new TooLarge();
      yield chunk;
    }
  };
  const key = attachmentKey(workspaceId);
  let sizeBytes: number;
  try {
    ({ sizeBytes } = await storage.put(key, counted()));
  } catch (err) {
    if (err instanceof TooLarge) throw tooLarge(limits.fileBytes, "The file");
    if (err instanceof StorageFullError) throw new ApiError("storage_low", "The server ran out of storage space. Ask an administrator.");
    throw err;
  }
  try {
    return await getDb().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ATTACHMENT_WORKSPACE_LOCK_SPACE}::int, hashtext(${workspaceId}))`;
      const used = await tx.attachment.aggregate({ where: { workspaceId }, _sum: { sizeBytes: true } });
      if ((used._sum.sizeBytes ?? 0) + sizeBytes > limits.workspaceBytes) throw tooLarge(limits.workspaceBytes, "This workspace's attachments together");
      const latest = await tx.attachment.findFirst({ where: { workspaceId, name: input.name }, orderBy: { version: "desc" }, select: { version: true } });
      return tx.attachment.create({
        data: { workspaceId, name: input.name, version: (latest?.version ?? 0) + 1, storageKey: key, contentType: input.contentType, sizeBytes },
        select: { id: true, name: true, version: true, contentType: true, sizeBytes: true },
      });
    });
  } catch (err) {
    await storage.delete(key).catch(() => {});
    throw err;
  }
}
