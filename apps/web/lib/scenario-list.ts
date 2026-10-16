// Client-safe pieces of the scenario list (no database imports).
import type { RunStatus } from "@defe2end/shared";
import type { ScenarioSummary } from "./scenarios";

/** Runs shown per scenario in the list's mini history. */
export const RECENT_RUNS = 10;

export interface ScenarioListRow extends ScenarioSummary {
  /** First line of the description. */
  summary: string;
  updatedByName: string | null;
  /** Latest runs, oldest first (at most RECENT_RUNS); the last one is the "last run". */
  recent: { id: string; status: RunStatus; queuedAt: string }[];
}
