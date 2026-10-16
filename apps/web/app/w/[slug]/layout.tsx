import type { ReactNode } from "react";
import { ChatPanel } from "../../../components/ai/chat-panel";
import { NavigationGuardHost } from "../../../components/navigation-guard";
import { Sidebar } from "../../../components/sidebar";
import { listMyWorkspaces, requireWorkspace } from "../../../lib/page";
import { SideBrowserPanel } from "./side-browser-panel";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { actor, workspace } = await requireWorkspace(slug);
  const workspaces = await listMyWorkspaces(actor.userId);
  const current = workspaces.find((w) => w.id === workspace.id)!;
  return (
    <div className="flex min-h-screen">
      <Sidebar current={current} workspaces={workspaces} user={actor.user} />
      <main className="min-w-0 flex-1">{children}</main>
      <SideBrowserPanel />
      <ChatPanel />
      <NavigationGuardHost />
    </div>
  );
}
