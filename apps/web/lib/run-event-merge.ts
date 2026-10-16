// Shared by the SSE route and the run screen (client): the event shapes and how they merge. No server imports.
import type { ArtifactView, RunDetail, RunStepView } from "./run-read";

/**
 * `snapshot`: the whole run, sent first on every (re)connect. `update`: what changed since the last event —
 * run fields always, plus changed steps and new artifacts; the screen merges them by step index and
 * artifact id. `end`: the run reached a terminal state; the server closes right after.
 */
export type RunEvent =
  | { type: "snapshot"; run: RunDetail }
  | { type: "update"; run: Omit<RunDetail, "steps" | "artifacts">; steps: RunStepView[]; artifacts: ArtifactView[] }
  | { type: "end" };

export function diffRun(prev: RunDetail, next: RunDetail): Extract<RunEvent, { type: "update" }> | null {
  const { steps, artifacts, ...run } = next;
  const { steps: prevSteps, artifacts: prevArtifacts, ...prevRun } = prev;
  const changedSteps = steps.filter((s, i) => JSON.stringify(s) !== JSON.stringify(prevSteps[i]));
  const known = new Set(prevArtifacts.map((a) => a.id));
  const newArtifacts = artifacts.filter((a) => !known.has(a.id));
  if (changedSteps.length === 0 && newArtifacts.length === 0 && JSON.stringify(run) === JSON.stringify(prevRun)) return null;
  return { type: "update", run, steps: changedSteps, artifacts: newArtifacts };
}

/** Merges an event into the screen's copy of the run (the client side of `diffRun`). */
export function applyRunEvent(current: RunDetail | null, event: RunEvent): RunDetail | null {
  if (event.type === "snapshot") return event.run;
  if (event.type === "end" || !current) return current;
  const steps = current.steps.map((s) => event.steps.find((c) => c.index === s.index) ?? s);
  const known = new Set(current.artifacts.map((a) => a.id));
  return { ...current, ...event.run, steps, artifacts: [...current.artifacts, ...event.artifacts.filter((a) => !known.has(a.id))] };
}
