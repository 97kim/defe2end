import { openDesktopStream, streamResponse } from "../../../../lib/desktop/stream";
import { desktopRoute } from "../../../../lib/desktop/auth";

export const dynamic = "force-dynamic";

/** The app's event stream (stage 4 contract section 3.2): bearer token, version headers, 401 / 426. */
export const GET = desktopRoute(async ({ request }) => {
  const opened = await openDesktopStream(request);
  if (!opened.ok) return opened.response;
  return streamResponse(opened.session, request.signal);
});
