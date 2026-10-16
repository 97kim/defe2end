import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDbClient } from "@defe2end/db";
import { workerDatabaseUrl } from "./database-url.js";

/**
 * Integration tests get their own database (`<TEST_DATABASE_URL db>_worker`) so they never truncate tables
 * under the web tests, which turbo runs at the same time. Also builds dist/ for the SIGKILL test's child worker.
 */
export default async function setup() {
  const url = workerDatabaseUrl();
  if (!url) {
    if (process.env.CI) throw new Error("TEST_DATABASE_URL must be set in CI so integration tests run");
    console.warn("\nTEST_DATABASE_URL is not set: worker integration tests are skipped.\n");
    return;
  }
  const admin = createDbClient(process.env.TEST_DATABASE_URL);
  const name = new URL(url).pathname.slice(1);
  const [exists] = await admin.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${name}`;
  if (!exists?.n) await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  await admin.$disconnect();
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../../packages/db", import.meta.url)),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
  execFileSync("node_modules/.bin/tsc", ["-p", "tsconfig.build.json"], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit" });
}
