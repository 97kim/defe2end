"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Alert, Button } from "../../../../../components/ui";

// "AI connection" (stage 6 contract section 6): registers the app's `defe2end-mcp` in Claude Code / Codex. Only
// inside the desktop app (the preload's `mcp` group); in a plain browser nothing renders.

type Cli = "claude" | "codex";
type State = "registered" | "outdated" | "missing" | "not-installed";
interface Registration {
  cli: Cli;
  state: State;
}
interface McpBridge {
  state(): Promise<Registration[] | undefined>;
  register(cli: Cli): Promise<Registration | null | undefined>;
}

function mcpBridge(win: unknown): McpBridge | null {
  const mcp = (win as { defe2end?: { mcp?: Partial<McpBridge> } } | undefined)?.defe2end?.mcp;
  return mcp && typeof mcp.state === "function" && typeof mcp.register === "function" ? (mcp as McpBridge) : null;
}

const NAMES: Record<Cli, string> = { claude: "Claude Code", codex: "Codex" };

export function AiConnection() {
  const t = useTranslations("settings.aiConnection");
  const [bridge, setBridge] = useState<McpBridge | null>(null);
  const [rows, setRows] = useState<Registration[]>([]);
  const [busy, setBusy] = useState<Cli | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const b = mcpBridge(window);
    setBridge(b);
    void b?.state().then((r) => setRows(r ?? []));
  }, []);
  if (!bridge) return null;

  async function register(cli: Cli) {
    setBusy(cli);
    setFailed(false);
    const result = await bridge!.register(cli).catch(() => null);
    if (!result || result.state !== "registered") setFailed(true);
    setRows((await bridge!.state().catch(() => undefined)) ?? rows);
    setBusy(null);
  }

  return (
    <section className="mb-8 space-y-3">
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      <p className="text-sm text-gray-600">{t("hint")}</p>
      {failed && <Alert>{t("failed")}</Alert>}
      <ul className="divide-y rounded border">
        {rows.map((r) => (
          <li key={r.cli} className="flex items-center justify-between gap-4 p-3">
            <div>
              <div className="font-medium">{NAMES[r.cli]}</div>
              <div className="text-sm text-gray-600">{t(`states.${r.state}`)}</div>
            </div>
            {r.state !== "not-installed" && (
              <Button variant={r.state === "registered" ? "secondary" : "primary"} disabled={busy !== null} onClick={() => void register(r.cli)}>
                {r.state === "registered" ? t("reregister") : t("register")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
