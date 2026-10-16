import { headers } from "next/headers";
import { AccessDenied } from "../components/access-denied";
import { getActor } from "../lib/actor";
import { listMyWorkspaces } from "../lib/page";

export default async function NotFound() {
  const actor = await getActor(await headers());
  const workspaces = actor ? await listMyWorkspaces(actor.userId) : undefined;
  return <AccessDenied kind="not_found" workspaces={workspaces} />;
}
