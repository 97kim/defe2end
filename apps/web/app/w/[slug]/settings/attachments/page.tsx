import { canInWorkspace, requireWorkspace } from "../../../../../lib/page";
import { listAttachments } from "../../../../../lib/attachments";
import { WRITE_ENDPOINTS } from "../../../../../lib/run-endpoints";
import { AttachmentsManager } from "./attachments-manager";

export default async function AttachmentsSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const [attachments, canWrite] = await Promise.all([listAttachments(workspace), canInWorkspace(slug, "attachment.write")]);
  return <AttachmentsManager slug={slug} attachments={attachments} canWrite={canWrite} uploadAvailable={WRITE_ENDPOINTS.attachmentUpload.available} />;
}
