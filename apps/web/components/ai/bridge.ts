"use client";

import { useEffect, useState } from "react";

// The preload's `ai` bundle (apps/desktop/src/preload.ts, stage 6 contract section 7): provider status, send (chat
// turn or one diagnosis turn), stop, events. Absent in a plain browser, where nothing AI-related renders.

export type Provider = "claude" | "codex";
export const PROVIDERS: readonly Provider[] = ["claude", "codex"];

export type ProviderState =
  | { provider: Provider; state: "ready"; version: string }
  | { provider: Provider; state: "unsupported"; version: string; minVersion: string }
  | { provider: Provider; state: "missing"; candidates: number };

export type AiEvent =
  | { threadId: string; type: "delta"; text: string }
  | { threadId: string; type: "done"; text: string }
  | { threadId: string; type: "error"; code: "auth" | "missing" | "failed" | "stopped" | "unsafe"; message: string };

export type SendResult = { ok: true } | { ok: false; reason: string };

export interface AiBridge {
  status(refresh?: boolean): Promise<ProviderState[]>;
  send(input: { mode?: "chat" | "diagnosis"; threadId: string; provider: Provider; text: string; images?: { mediaType: string; base64: string }[] }): Promise<SendResult>;
  stop(threadId: string): Promise<boolean>;
  onEvent(listener: (event: AiEvent) => void): () => void;
}

export function aiBridge(win: unknown): AiBridge | null {
  const ai = (win as { defe2end?: { ai?: Partial<AiBridge> } } | undefined)?.defe2end?.ai;
  if (!ai || !["status", "send", "stop", "onEvent"].every((n) => typeof (ai as Record<string, unknown>)[n] === "function")) return null;
  return ai as AiBridge;
}

/** Read after mount, so the server render and a plain browser both show nothing. */
export function useAiBridge(): AiBridge | null {
  const [bridge, setBridge] = useState<AiBridge | null>(null);
  useEffect(() => setBridge(aiBridge(window)), []);
  return bridge;
}

/** Provider status with a re-check; null while the first check runs. */
export function useProviderStatus(bridge: AiBridge | null): { states: ProviderState[] | null; recheck: () => void; checking: boolean } {
  const [states, setStates] = useState<ProviderState[] | null>(null);
  const [checking, setChecking] = useState(false);
  const load = (refresh: boolean) => {
    if (!bridge) return;
    setChecking(true);
    bridge
      .status(refresh)
      .then(setStates)
      .catch(() => setStates([]))
      .finally(() => setChecking(false));
  };
  useEffect(() => load(false), [bridge]); // eslint-disable-line react-hooks/exhaustive-deps
  return { states, recheck: () => load(true), checking };
}

export const INSTALL_URL: Record<Provider, string> = {
  claude: "https://docs.anthropic.com/en/docs/claude-code/setup",
  codex: "https://github.com/openai/codex#installing-and-running-codex-cli",
};

export const LOGIN_COMMAND: Record<Provider, string> = { claude: "claude login", codex: "codex login" };
