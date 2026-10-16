#!/usr/bin/env node
// `defe2end-mcp`: stdio MCP server started by Claude Code / Codex (stage 6 contract section 2).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createConnector } from "./locate.js";
import { createDefe2endMcpServer } from "./server.js";

const { server, close } = createDefe2endMcpServer({ connector: createConnector() });
const transport = new StdioServerTransport();
transport.onclose = () => {
  close();
  process.exit(0);
};
process.stdin.on("end", () => transport.close());
await server.connect(transport);
