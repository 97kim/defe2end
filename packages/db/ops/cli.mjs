#!/usr/bin/env node
// Backup and restore for a defE2End server (stage 8 contract section 4). Runs inside the migrate image:
//   docker compose stop web worker
//   docker compose run --rm --no-deps -v "$PWD/backups/<name>:/backup" migrate backup /backup
//   docker compose run --rm --no-deps -v "$PWD/backups/<name>:/backup" migrate restore /backup
//   docker compose run --rm --no-deps migrate resume-automation
// A backup directory holds `db.dump` (pg_dump custom format), `files/` (the file storage, one file per key)
// and `manifest.json`. The encryption key and other secrets are never written: keep the key separately.
import { spawn } from "node:child_process";
import { createDecipheriv, createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, constants, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORMAT = 1;
const TEMP_DIR = ".tmp";
// Names only: the restored server needs these set, with the same DEFE2END_ENCRYPTION_KEY as the original.
const REQUIRED_ENV = ["DATABASE_URL", "DEFE2END_ENCRYPTION_KEY", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "STORAGE_DIR"];
const OPTIONAL_ENV = [
  "OIDC_DISCOVERY_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_PROVIDER_NAME",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
];

const USAGE = `Usage:
  backup <dir>                      Stop web and worker first. Dumps the database, then copies the file
                                    storage, into an empty directory <dir>.
  restore [--without-key] <dir>     Restores a backup into an empty database and an empty file storage.
                                    Automation (schedules, notifications, queued runs) stays paused.
                                    --without-key: only when the original key is lost. Secrets and login
                                    sessions are dropped and must be entered again.
  resume-automation                 Resumes automation after you checked the restored instance.

Needs DATABASE_URL, STORAGE_DIR (mount the storage volume, as web and worker do) and DEFE2END_ENCRYPTION_KEY.
The encryption key is not part of a backup. Keep DEFE2END_ENCRYPTION_KEY somewhere safe: without the
original key the restored server won't start, and stored secrets can't be read.`;

const KEY_CHECK_TEXT = "defe2end-backup-key-check";
const APP_CONNECTION_NAME = "defe2end-app";

class UserError extends Error {}

function encryptionKey() {
  const raw = process.env.DEFE2END_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) fail("DEFE2END_ENCRYPTION_KEY must be base64 of exactly 32 bytes.");
  return key;
}

/** HMAC of a fixed text with the key: tells whether two keys are the same without storing either. */
function keyCheck(key) {
  return createHmac("sha256", key).update(KEY_CHECK_TEXT).digest("hex");
}

/** Same format as the server's encryptSecret (`v1:<iv>:<tag>:<data>`, AES-256-GCM). */
function canDecrypt(ciphertext, key) {
  try {
    const [version, iv, tag, data] = ciphertext.split(":");
    if (version !== "v1") return false;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  throw new UserError(message);
}

/** libpq rejects Prisma-only URL parameters such as `schema`. */
function libpqUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) fail("DATABASE_URL is not set.");
  const url = new URL(raw);
  url.searchParams.delete("schema");
  return url.toString();
}

function storageDir() {
  const dir = process.env.STORAGE_DIR;
  if (!dir) fail("STORAGE_DIR is not set. Run with the storage volume mounted and STORAGE_DIR pointing at it.");
  return resolve(dir);
}

function run(command, args, { capture = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => {
      err += chunk;
      if (!capture) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? done(out) : reject(new UserError(`${command} failed (exit ${code})${capture ? `: ${err.trim()}` : ""}`)),
    );
  });
}

function sql(query) {
  return run("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", libpqUrl(), "-c", query], { capture: true }).then((s) =>
    s.trim(),
  );
}

async function appVersion() {
  // The release build stamps the version into package.json; DEFE2END_VERSION overrides it.
  return process.env.DEFE2END_VERSION || JSON.parse(await readFile(join(APP_DIR, "package.json"), "utf8")).version;
}

/** The migrations this image ships, with the SHA-256 of each migration.sql. */
async function imageMigrations() {
  const dir = join(APP_DIR, "prisma", "migrations");
  const names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return Promise.all(names.map(async (name) => ({ name, sha256: (await hashFile(join(dir, name, "migration.sql"))).sha256 })));
}

async function databaseMigrations() {
  const exists = await sql("SELECT to_regclass('public._prisma_migrations') IS NOT NULL");
  if (exists !== "t") return [];
  const names = await sql(
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name",
  );
  return names ? names.split("\n") : [];
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Stored files, relative keys with `/`, skipping the in-progress uploads under `.tmp`. */
async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (dir === root && (entry.name === TEMP_DIR || entry.name === "lost+found")) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out.push(relative(root, path).split(sep).join("/"));
    }
  }
  await walk(root);
  return out.sort();
}

/** Copies `from` to `to` (through a temp file when `temp` is given), returning size and SHA-256. */
async function copyHashed(from, to, temp) {
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  await mkdir(dirname(to), { recursive: true });
  const target = temp ?? to;
  await pipeline(createReadStream(from), tap, createWriteStream(target, { flags: "wx", mode: 0o640 }));
  if (temp) await rename(temp, to);
  return { size, sha256: hash.digest("hex") };
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

async function isEmptyDir(dir) {
  try {
    return (await readdir(dir)).length === 0;
  } catch (err) {
    if (err.code === "ENOENT") return true;
    throw err;
  }
}

async function ensureWritable(dir) {
  await mkdir(dir, { recursive: true }).catch(() => {});
  try {
    await access(dir, constants.W_OK);
  } catch {
    fail(`${dir} is not writable by this container's user (uid ${process.getuid?.()}). Make the mounted directory writable for it.`);
  }
}

function formatBytes(n) {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

async function backup(dir) {
  const target = resolve(dir);
  const root = storageDir();
  if (!(await isEmptyDir(target))) fail(`${target} is not empty. Back up into a new, empty directory.`);
  await ensureWritable(target);

  const version = await appVersion();
  const migrations = await imageMigrations();
  const applied = await databaseMigrations();
  if (applied.length === 0) fail("The database has no applied migrations; there is nothing to back up.");
  if (!sameList(applied, migrations.map((m) => m.name))) {
    fail(
      `The database is at migration ${applied.at(-1)}, but this image (version ${version}) has ${migrations.at(-1)?.name}. ` +
        "Back up with the image of the version the server runs.",
    );
  }
  const migration = applied.at(-1);

  // Web and worker must be stopped: a live app keeps writing files and rows the dump would not match.
  // A just-stopped app's connections take a moment to go: look again for a few seconds before refusing.
  let appConnections = 0;
  for (let i = 0; i < 10; i++) {
    appConnections = Number(
      await sql(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND application_name = '${APP_CONNECTION_NAME}'`),
    );
    if (appConnections === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (appConnections > 0) {
    fail(`web or worker is still connected to the database (${appConnections} connections). Stop them first: docker compose stop web worker`);
  }

  const key = encryptionKey();
  if (!key) fail("DEFE2END_ENCRYPTION_KEY is not set. Run backup with the server's key: the backup records a check of it (not the key).");
  const stored = await sql(`SELECT coalesce((SELECT "encryptionKeyCheck" FROM "InstanceSetting" WHERE id = 1), '')`);
  if (stored && !canDecrypt(stored, key)) fail("DEFE2END_ENCRYPTION_KEY is not the key this database was set up with.");

  // 1. One consistent snapshot of the database (pg_dump reads it in a single transaction).
  const startedAt = new Date().toISOString();
  console.log("Dumping the database...");
  await run("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", join(target, "db.dump"), "--dbname", libpqUrl()]);
  const dump = await hashFile(join(target, "db.dump"));

  // 2. Files after the dump, so every file the dump points at is here. Files created later are copied too
  //    (harmless: unregistered files are removed by the orphan cleanup). Files deleted meanwhile are skipped.
  console.log("Copying the file storage...");
  const files = [];
  let skipped = 0;
  for (const key of await listFiles(root)) {
    try {
      files.push({ key, ...(await copyHashed(join(root, key), join(target, "files", key))) });
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      skipped++;
    }
  }
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  const manifest = {
    format: FORMAT,
    appVersion: version,
    migration,
    migrations,
    keyCheck: keyCheck(key),
    createdAt: startedAt,
    database: { file: "db.dump", format: "pg_dump custom", size: dump.size, sha256: dump.sha256 },
    environment: {
      required: REQUIRED_ENV,
      optional: OPTIONAL_ENV,
      note: "Names only. Restore with the same DEFE2END_ENCRYPTION_KEY as the original server; it is not in this backup.",
    },
    files: { count: files.length, totalBytes, entries: files },
  };
  await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    [
      "",
      `Backup done: ${target}`,
      `  version ${version}, migration ${migration}`,
      `  database dump ${formatBytes(dump.size)}, ${files.length} files (${formatBytes(totalBytes)})${skipped ? `, ${skipped} deleted during the backup` : ""}`,
      "The encryption key is not in the backup. Keep DEFE2END_ENCRYPTION_KEY with it, stored separately.",
    ].join("\n"),
  );
}

async function restore(dir, { withoutKey }) {
  const source = resolve(dir);
  const root = storageDir();
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
  } catch {
    fail(`${join(source, "manifest.json")} is missing or unreadable; ${source} is not a backup directory.`);
  }
  if (manifest.format !== FORMAT) fail(`Unknown backup format ${manifest.format}.`);

  const version = await appVersion();
  const migrations = await imageMigrations();
  const sameMigrations = sameList(
    (manifest.migrations ?? []).map((m) => `${m.name}:${m.sha256}`),
    migrations.map((m) => `${m.name}:${m.sha256}`),
  );
  if (manifest.appVersion !== version || !sameMigrations) {
    fail(
      `This backup is from version ${manifest.appVersion} (migration ${manifest.migration}); this image is version ${version} ` +
        `(migration ${migrations.at(-1)?.name}). Restore with the image of version ${manifest.appVersion} first, then upgrade as usual.`,
    );
  }

  const key = encryptionKey();
  if (!withoutKey) {
    if (!key) fail("DEFE2END_ENCRYPTION_KEY is not set. Restore with the original server's key.");
    if (keyCheck(key) !== manifest.keyCheck) {
      fail(
        "DEFE2END_ENCRYPTION_KEY is not the key this backup was made with. Set the original key. Only if it is lost, " +
          "restore with --without-key: secrets and login sessions are then dropped and must be entered again.",
      );
    }
  } else if (!key) {
    fail("DEFE2END_ENCRYPTION_KEY is not set. With --without-key, set the new key the restored server will use.");
  }

  // Only into empty targets: there is no option to overwrite.
  const tables = Number(await sql("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"));
  if (tables > 0) {
    fail(
      `The database already has ${tables} tables. Restore needs an empty database: start only postgres on a fresh volume ` +
        "(`docker compose up -d postgres`), without running migrate or the web server first.",
    );
  }
  const existing = await listFiles(root).catch((err) => (err.code === "ENOENT" ? [] : Promise.reject(err)));
  if (existing.length > 0) fail(`The file storage ${root} already has ${existing.length} files. Restore needs an empty storage volume.`);
  await ensureWritable(root);

  // Check everything before touching the database.
  console.log("Checking the backup...");
  const dump = await hashFile(join(source, "db.dump"));
  if (dump.sha256 !== manifest.database.sha256) fail("db.dump does not match its checksum in manifest.json; the backup is damaged.");
  for (const f of manifest.files.entries) {
    if (f.key.split("/").some((part) => part === ".." || part === "") || f.key.startsWith(`${TEMP_DIR}/`)) fail(`Invalid file key ${f.key}.`);
    const got = await hashFile(join(source, "files", f.key)).catch(() => null);
    if (!got || got.sha256 !== f.sha256) fail(`files/${f.key} is missing or does not match its checksum; the backup is damaged.`);
  }

  // One transaction: the dump, the "restore in progress" mark and the isolation land together or not at all.
  console.log("Restoring the database...");
  await restoreDatabase(join(source, "db.dump"), isolationSql(withoutKey));

  console.log("Restoring the file storage...");
  const tempDir = join(root, TEMP_DIR);
  await mkdir(tempDir, { recursive: true });
  for (const f of manifest.files.entries) {
    const got = await copyHashed(join(source, "files", f.key), join(root, f.key), join(tempDir, `restore-${f.sha256}`));
    if (got.sha256 !== f.sha256) {
      await rm(join(root, f.key), { force: true });
      fail(`files/${f.key} changed while it was restored.`);
    }
  }
  await sql(`UPDATE "InstanceSetting" SET "restoreInProgressAt" = NULL WHERE id = 1`);

  const counts = await sql(
    'SELECT (SELECT count(*) FROM "user") || \' users, \' || (SELECT count(*) FROM "Workspace") || \' workspaces, \' || ' +
      '(SELECT count(*) FROM "Scenario") || \' scenarios, \' || (SELECT count(*) FROM "Run") || \' runs\'',
  ).catch(() => "");
  console.log(
    [
      "",
      `Restore done from a backup made ${manifest.createdAt}.`,
      `  version ${version}, migration ${manifest.migration}${counts ? `, ${counts}` : ""}`,
      `  ${manifest.files.count} files (${formatBytes(manifest.files.totalBytes)}), checksums verified`,
      "Automation is paused: schedules, notifications and queued runs wait. Runs that were going are ended as",
      "error(restore_interrupted), pending notifications as dead. Check the instance, then resume:",
      "  docker compose run --rm --no-deps migrate resume-automation",
      withoutKey
        ? "Restored without the original key: secret values and login sessions were dropped. Enter the secrets again; notification webhook URLs can't be read and must be set again."
        : "Start web and worker with the same DEFE2END_ENCRYPTION_KEY.",
    ].join("\n"),
  );
}

function isolationSql(withoutKey) {
  const lines = [
    `INSERT INTO public."InstanceSetting" (id, "restoreInProgressAt", "automationPausedAt") VALUES (1, now(), now())
       ON CONFLICT (id) DO UPDATE SET "restoreInProgressAt" = now(), "automationPausedAt" = now();`,
    `UPDATE public."Run" SET status = 'error', "errorCode" = 'restore_interrupted',
       "errorMessage" = 'The instance was restored from a backup while this run was going.', "finishedAt" = now(),
       "claimToken" = NULL, "leaseExpiresAt" = NULL WHERE status = 'running';`,
    `UPDATE public."EnvComparison" SET status = 'error', error = 'restore_interrupted', "claimToken" = NULL
       WHERE status IN ('running', 'comparing');`,
    `UPDATE public."NotificationDelivery" SET status = 'dead', "claimToken" = NULL, "leaseExpiresAt" = NULL
       WHERE status IN ('pending', 'sending');`,
  ];
  if (withoutKey) {
    for (const table of ["Variable", "PersonalVariableValue", "ScheduleVariableValue", "BotVariableValue"]) {
      lines.push(`UPDATE public."${table}" SET "valueEncrypted" = NULL WHERE "valueEncrypted" IS NOT NULL;`);
    }
    lines.push(`DELETE FROM public.session;`, `UPDATE public."InstanceSetting" SET "encryptionKeyCheck" = NULL WHERE id = 1;`);
  }
  return `${lines.join("\n")}\n`;
}

/** pg_restore writes SQL, psql runs it plus `extra` in one transaction that stops at the first error. */
function restoreDatabase(dumpFile, extra) {
  return new Promise((done, reject) => {
    const psql = spawn("psql", ["-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-d", libpqUrl(), "-f", "-"], { stdio: ["pipe", "ignore", "inherit"] });
    const dump = spawn("pg_restore", ["--no-owner", "--no-acl", "-f", "-", dumpFile], { stdio: ["ignore", "pipe", "inherit"] });
    dump.stdout.pipe(psql.stdin, { end: false });
    dump.on("error", reject);
    psql.on("error", reject);
    dump.on("close", (code) => {
      if (code !== 0) {
        psql.stdin.destroy();
        reject(new UserError(`pg_restore failed (exit ${code})`));
        return;
      }
      psql.stdin.end(extra);
    });
    psql.on("close", (code) => (code === 0 ? done() : reject(new UserError(`restoring the database failed (psql exit ${code}); nothing was committed`))));
  });
}

async function resumeAutomation() {
  const state = await sql(`SELECT coalesce("restoreInProgressAt"::text, '') || '|' || coalesce("automationPausedAt"::text, '') FROM "InstanceSetting" WHERE id = 1`);
  const [restoring, paused] = state.split("|");
  if (restoring) fail("A restore did not finish; resuming is refused. Start the restore over on an empty database and storage.");
  if (!paused) {
    console.log("Automation is not paused.");
    return;
  }
  await sql(`UPDATE "InstanceSetting" SET "automationPausedAt" = NULL WHERE id = 1`);
  console.log("Automation resumed: schedules, notifications and queued runs start on the worker's next round.");
}

async function main() {
  const args = process.argv.slice(2);
  const withoutKey = args.includes("--without-key");
  const [command, dir, ...rest] = args.filter((a) => a !== "--without-key");
  if (command === "--help" || command === "-h" || command === "help" || !command) {
    console.log(USAGE);
    return;
  }
  if (command === "resume-automation" && !dir) return resumeAutomation();
  if (!["backup", "restore"].includes(command) || !dir || rest.length > 0 || (withoutKey && command !== "restore")) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  await (command === "backup" ? backup(dir) : restore(dir, { withoutKey }));
}

main().catch((err) => {
  console.error(`${process.argv[2] ?? "ops"} failed: ${err instanceof UserError ? err.message : (err?.stack ?? String(err))}`);
  process.exitCode = 1;
});
