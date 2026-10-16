// The compose file must pass every worker setting through, or values set in deploy/.env are silently ignored.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "./config.js";

const deploy = new URL("../../../deploy/", import.meta.url);
const key = Buffer.alloc(32, 1).toString("base64");

/** Every env key loadConfig reads, recorded through a proxy. */
function keysRead(): string[] {
  const read = new Set<string>();
  const env = new Proxy({ DEFE2END_ENCRYPTION_KEY: key } as NodeJS.ProcessEnv, {
    get(target, name) {
      if (typeof name === "string") read.add(name);
      return target[name as string];
    },
  });
  loadConfig(env);
  return [...read].sort();
}

const worker = parse(readFileSync(new URL("docker-compose.yml", deploy), "utf8"), { merge: true }).services.worker;
const environment: Record<string, unknown> = worker.environment;

it("passes every env key the worker config reads into the worker container", () => {
  const keys = keysRead();
  expect(keys).toEqual(expect.arrayContaining(["RUN_RETRY_ATTEMPTS", "BLOCK_PRIVATE_NETWORKS", "HEARTBEAT_INTERVAL_MS"]));
  expect(keys.filter((k) => !(k in environment))).toEqual([]);
});

it("uses the worker's own defaults when .env leaves a setting out", () => {
  const defaults: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(environment)) {
    const m = /^\$\{\w+:-(.*)\}$/.exec(String(v));
    if (m) defaults[k] = m[1];
  }
  const { workerId: _a, encryptionKey: _b, storageDir: _c, ...fromCompose } = loadConfig({ ...defaults, DEFE2END_ENCRYPTION_KEY: key });
  const { workerId: _d, encryptionKey: _e, storageDir: _f, ...builtIn } = loadConfig({ DEFE2END_ENCRYPTION_KEY: key });
  expect(fromCompose).toEqual(builtIn);
});

it("documents every passed-through worker setting in .env.example", () => {
  const example = readFileSync(new URL(".env.example", deploy), "utf8");
  const missing = keysRead().filter((k) => !["DEFE2END_ENCRYPTION_KEY", "STORAGE_DIR"].includes(k) && !new RegExp(`^${k}=`, "m").test(example));
  expect(missing).toEqual([]);
});
