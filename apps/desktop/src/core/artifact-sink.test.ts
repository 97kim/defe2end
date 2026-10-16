import { describe, expect, it } from "vitest";
import { artifactKey, uploadSink } from "./artifact-sink.js";

describe("artifact upload keys", () => {
  it("gives each step's log its own key and keeps the run-wide log one file", async () => {
    const paths: string[] = [];
    const sink = uploadSink({
      api: {
        request: async (path: string) => {
          paths.push(path);
          return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
        },
      } as never,
      runId: "run-1",
      claimToken: "claim",
      onOwnershipLost: () => {},
    });
    const refs = [];
    for (const meta of [
      { kind: "log" as const, name: "step-1-console", stepIndex: 0 },
      { kind: "log" as const, name: "step-3-console", stepIndex: 2 },
      { kind: "log" as const, name: "run.log" },
    ]) {
      const writer = await sink.open(meta);
      await writer.write(new TextEncoder().encode("line\n"));
      refs.push(await writer.complete());
    }
    expect(paths).toEqual(["/api/desktop/runs/run-1/artifacts/log/1/step-0", "/api/desktop/runs/run-1/artifacts/log/1/step-2", "/api/desktop/runs/run-1/artifacts/log/1/log"]);
    expect(refs.map((r) => r.stepIndex)).toEqual([0, 2, undefined]);
    expect(artifactKey({ kind: "dom_summary", name: "step-3-dom", stepIndex: 2 })).toBe("step-2");
  });
});
