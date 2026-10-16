import { desktopRoute } from "../../../../../../../lib/desktop/auth";
import { getBaseline } from "../../../../../../../lib/desktop/runs";

export const dynamic = "force-dynamic";

/** A baseline version pinned for the run (stage 7 contract section 4). */
export const GET = desktopRoute<{ id: string; versionId: string }>(async ({ params, principal }) => getBaseline(principal, params.id, params.versionId));
