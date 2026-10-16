import { DESKTOP_PROTOCOL_VERSION } from "@defe2end/shared";
import { allowedAuthOrigins, desktopMinVersion } from "../../../../lib/desktop/config";

export const dynamic = "force-dynamic";

/** Public: the app reads it before anyone signs in (stage 4 contract section 3.1). */
export async function GET() {
  return Response.json({ authOrigins: await allowedAuthOrigins(), minimum: desktopMinVersion(), protocol: DESKTOP_PROTOCOL_VERSION });
}
