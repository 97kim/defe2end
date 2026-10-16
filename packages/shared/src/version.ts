/** Contract versions (plan section 6). Bump each one independently when its contract changes. */
export const VERSIONS = {
  server: "0.0.0",
  desktop: "0.0.0",
  runner: "0.0.0",
  mcp: "0.0.0",
  /** Scenario step format; stored with exports so imports can reject unknown formats. */
  stepFormat: 1,
} as const;
