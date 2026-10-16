// Side browser find bar (desktop spec 4): the rules that don't need Electron.

export interface KeyInput {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

/** ⌘F on macOS, Ctrl+F elsewhere, on key down in a side browser tab. */
export function isFindShortcut(input: KeyInput, platform: NodeJS.Platform): boolean {
  if (input.type !== "keyDown" || input.alt || input.key.toLowerCase() !== "f") return false;
  return platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
}

export interface FindQuery {
  text: string;
  /** False = previous match (Shift+Enter, "Previous"). */
  forward: boolean;
  /** True when moving between matches of the same text rather than starting a new search. */
  findNext: boolean;
}

export const FIND_TEXT_MAX = 500;

/** The find bar's `find:query` payload, or null when it isn't one. */
export function parseFindQuery(payload: unknown): FindQuery | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { text, forward, findNext } = payload as Record<string, unknown>;
  if (typeof text !== "string" || typeof forward !== "boolean" || typeof findNext !== "boolean") return null;
  if (text.length > FIND_TEXT_MAX) return null;
  return { text, forward, findNext };
}

/** "n/m", or the no-match label; empty before any search. */
export function matchLabel(result: { activeMatchOrdinal: number; matches: number } | null, noMatches: string): string {
  if (!result) return "";
  return result.matches === 0 ? noMatches : `${result.activeMatchOrdinal}/${result.matches}`;
}
