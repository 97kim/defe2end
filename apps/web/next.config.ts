import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const config: NextConfig = {
  output: "standalone",
  // Lets several people (or agents) run dev/build in one checkout without sharing .next.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Trace workspace packages from the monorepo root so the standalone bundle includes them.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // The bundled image comparison worker, started by path (lib/visual-compare.ts).
  outputFileTracingIncludes: { "/**": ["../../packages/shared/dist/visual-compare-worker.cjs"] },
  async headers() {
    return [
      // Pages that read a token from the URL fragment must never leak the URL via Referer.
      // /invite and /reset are reserved for the invite and reset-link pages.
      ...["/setup", "/invite", "/reset"].map((source) => ({
        source,
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      })),
    ];
  },
};

export default withNextIntl(config);
