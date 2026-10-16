import { headers } from "next/headers";
import { LinkPageFrame } from "../../components/accounts/link-page";
import { getActor } from "../../lib/actor";
import { authProviders } from "../../lib/auth";
import { InviteFlow } from "./invite-flow";

export const dynamic = "force-dynamic";

/** Public: opened from an invite link `/invite#token=…` (Referrer-Policy: no-referrer via next.config). */
export default async function InvitePage() {
  const actor = await getActor(await headers());
  const { oidc, github } = authProviders();
  const external = [...(oidc ? [{ id: oidc.providerId, name: oidc.name }] : []), ...(github ? [{ id: "github", name: "GitHub" }] : [])];
  return (
    <LinkPageFrame>
      <InviteFlow signedInEmail={actor?.user.email ?? null} external={external} />
    </LinkPageFrame>
  );
}
