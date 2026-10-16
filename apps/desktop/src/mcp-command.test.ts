import { describe, expect, it } from "vitest";
import { mcpCommand, registerArgs, registrationState } from "./mcp-command.js";

const cmd = mcpCommand({ execPath: "/A/defE2End", scriptPath: "/A/res/mcp/defe2end-mcp.mjs", mcpDir: "/U/mcp" });

describe("mcp command", () => {
  it("runs the app executable in Node mode with the mcp folder", () => {
    expect(cmd).toEqual({ command: "/A/defE2End", args: ["/A/res/mcp/defe2end-mcp.mjs"], env: { ELECTRON_RUN_AS_NODE: "1", DEFE2END_MCP_DIR: "/U/mcp" } });
  });

  it("builds claude and codex registration argv", () => {
    expect(registerArgs("claude", cmd).add).toEqual(["mcp", "add", "--scope", "user", "defe2end", "-e", "ELECTRON_RUN_AS_NODE=1", "-e", "DEFE2END_MCP_DIR=/U/mcp", "--", "/A/defE2End", "/A/res/mcp/defe2end-mcp.mjs"]);
    expect(registerArgs("codex", cmd).add).toEqual(["mcp", "add", "defe2end", "--env", "ELECTRON_RUN_AS_NODE=1", "--env", "DEFE2END_MCP_DIR=/U/mcp", "--", "/A/defE2End", "/A/res/mcp/defe2end-mcp.mjs"]);
  });

  it("tells registered, outdated and missing apart", () => {
    expect(registrationState(null, cmd)).toBe("missing");
    expect(registrationState("defe2end: /A/defE2End /A/res/mcp/defe2end-mcp.mjs", cmd)).toBe("registered");
    expect(registrationState("defe2end: /Old/defE2End /Old/mcp.js", cmd)).toBe("outdated");
  });
});

describe("registration", () => {
  it("removes then adds, and reports not-installed when the CLI can't run", async () => {
    const { register } = await import("./mcp-command.js");
    const calls: string[][] = [];
    let added = false;
    const run = async (cli: "claude" | "codex", args: string[]) => {
      calls.push([cli, ...args]);
      if (args[1] === "add") added = true;
      if (args[1] === "get") return added ? { code: 0, stdout: "defe2end /A/defE2End /A/res/mcp/defe2end-mcp.mjs" } : { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    };
    expect((await register("claude", cmd, run)).state).toBe("registered");
    expect(calls.map((c) => c[2])).toEqual(["remove", "add", "get"]);
    expect((await register("codex", cmd, async () => Promise.reject(new Error("ENOENT")))).state).toBe("not-installed");
  });
});
