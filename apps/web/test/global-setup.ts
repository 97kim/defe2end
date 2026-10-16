import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Applies pending migrations to TEST_DATABASE_URL once per run; test files empty the tables themselves (resetDatabase). */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    if (process.env.CI) throw new Error("TEST_DATABASE_URL must be set in CI so integration tests run");
    console.warn("\nTEST_DATABASE_URL is not set: integration tests are skipped (see docs/stage2-foundation.md).\n");
    return;
  }
  const dbPackage = fileURLToPath(new URL("../../../packages/db", import.meta.url));
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: dbPackage,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
}
