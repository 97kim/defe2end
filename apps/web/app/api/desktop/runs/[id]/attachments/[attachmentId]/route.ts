import { desktopRoute } from "../../../../../../../lib/desktop/auth";
import { getAttachment } from "../../../../../../../lib/desktop/runs";

export const dynamic = "force-dynamic";

/** A file pinned in the run's snapshot. */
export const GET = desktopRoute<{ id: string; attachmentId: string }>(async ({ params, principal }) => getAttachment(principal, params.id, params.attachmentId));
