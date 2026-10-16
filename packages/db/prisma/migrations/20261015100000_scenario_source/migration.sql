-- Stage 6 contract section 4: where a scenario was last created/changed from over MCP (`mcp:claude`, `mcp:codex`, `mcp:unknown`).
ALTER TABLE "Scenario" ADD COLUMN "source" TEXT;
