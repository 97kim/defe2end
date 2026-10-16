import { listBotTokens } from "../../../../../lib/bot-tokens";
import { canInWorkspace, requireWorkspace } from "../../../../../lib/page";
import { BotTokensView } from "./bot-tokens-view";

/** Bot tokens for the CI API, with their own values and login sessions (stage 5 contract section 7). */
export default async function BotTokensPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const [tokens, canWrite] = await Promise.all([listBotTokens(workspace.id), canInWorkspace(slug, "botToken.write")]);
  return <BotTokensView slug={slug} tokens={tokens} canWrite={canWrite} />;
}
