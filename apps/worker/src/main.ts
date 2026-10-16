import { assertMigrationsMatch, assertNotRestoring, createDbClient } from "@defe2end/db";
import { loadConfig } from "./config.js";
import { createWorker } from "./worker.js";

const config = loadConfig();
const db = createDbClient();
const worker = createWorker(db, config);

// Liveness record (stage 0); runs have their own lease heartbeats.
let inFlight: Promise<unknown> = Promise.resolve();
function beat(): void {
  inFlight = db.heartbeat.create({ data: { workerId: config.workerId } }).catch((err: unknown) => console.error("heartbeat failed", err));
}

try {
  await assertNotRestoring(db);
  await assertMigrationsMatch(db);
} catch (err) {
  console.error(`worker cannot start: ${(err as Error).message}`);
  process.exit(1);
}
console.log(`worker ${config.workerId} started, ${config.concurrency} concurrent runs, heartbeat every ${config.heartbeatMs}ms`);
beat();
const timer = setInterval(beat, config.heartbeatMs);
await worker.start();

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, finishing running runs (grace ${config.shutdownGraceMs}ms)`);
  await worker.stop();
  clearInterval(timer);
  await inFlight;
  await db.$disconnect();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
