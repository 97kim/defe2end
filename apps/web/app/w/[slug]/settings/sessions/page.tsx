import { listOwnAuthSessions } from "../../../../../lib/auth-sessions";
import { getDb } from "../../../../../lib/db";
import { canInWorkspace, requireWorkspace } from "../../../../../lib/page";
import { AiConnection } from "./ai-connection";
import { AiDiagnosisConsent } from "./ai-diagnosis-consent";
import { AuthSessionsView, type SessionRow } from "./sessions-view";

/** The caller's own login sessions, one row per environment that needs one (stage 4 contract section 5). */
export default async function AuthSessionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { workspace, actor } = await requireWorkspace(slug);
  const [environments, sessions, canWrite] = await Promise.all([
    getDb().environment.findMany({ where: { workspaceId: workspace.id, useAuthSession: true }, include: { site: { select: { name: true } } }, orderBy: [{ site: { name: "asc" } }, { name: "asc" }] }),
    listOwnAuthSessions(workspace.id, actor.userId),
    canInWorkspace(slug, "authSession.write"),
  ]);
  const byEnvironment = new Map(sessions.map((s) => [s.environmentId, s]));
  const rows: SessionRow[] = environments.map((e) => ({ environmentId: e.id, environmentName: e.name, siteName: e.site.name, baseUrl: e.baseUrl, session: byEnvironment.get(e.id) ?? null }));
  return (
    <>
      <AiConnection />
      <AiDiagnosisConsent />
      <AuthSessionsView slug={slug} rows={rows} canWrite={canWrite} />
    </>
  );
}
