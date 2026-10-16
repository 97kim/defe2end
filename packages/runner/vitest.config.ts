import { defineConfig } from "vitest/config";

// Real Chromium runs: a plan of many steps takes longer than vitest's 5 s default.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 30_000 } });
