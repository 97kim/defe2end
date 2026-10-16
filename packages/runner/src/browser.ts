// One Chromium process per run (contract section 4.3). Playwright starts it as the leader of its own process
// group, so killing `-pid` takes the renderers and helpers with it. Each browser carries marker switches
// (Chromium ignores unknown ones) naming its owner and run, so a restarted worker can find what a killed
// one left behind.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserServer } from "playwright";

const OWNER_SWITCH = "--defe2end-owner=";
const RUN_SWITCH = "--defe2end-run=";

export interface RunBrowser {
  browser: Browser;
  pid: number;
  /** Force-kills the process group and waits until it is gone. Safe to call more than once. */
  kill(): Promise<void>;
  /** Graceful close, falling back to kill; resolves once the process group is gone. */
  close(): Promise<void>;
}

/**
 * `hostRules`: Chromium `--host-resolver-rules` (see `hostResolverRules`). `executablePath`: a browser shipped
 * with the caller (the desktop app's bundled Chromium); unset = Playwright's installed one. `headless`: default
 * true; the desktop app shows the window unless its "hide the browser" setting is on.
 */
export async function launchBrowser(opts: { owner: string; runId: string; sandbox: boolean; hostRules: string; executablePath?: string; headless?: boolean }): Promise<RunBrowser> {
  const server = await chromium.launchServer({
    headless: opts.headless ?? true,
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    // The worker decides when browsers stop (SIGTERM grace, contract section 4.3); Playwright must not close them on signals.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    chromiumSandbox: opts.sandbox,
    args: [`${OWNER_SWITCH}${opts.owner}`, `${RUN_SWITCH}${opts.runId}`, `--host-resolver-rules=${opts.hostRules}`],
  });
  const pid = server.process().pid!;
  let browser: Browser;
  try {
    browser = await chromium.connect(server.wsEndpoint());
  } catch (err) {
    await stop(server, pid, true);
    throw err;
  }
  let stopping: Promise<void> | undefined;
  return {
    browser,
    pid,
    kill: () => (stopping ??= stop(server, pid, true)),
    close: () => (stopping ??= stop(server, pid, false)),
  };
}

async function stop(server: BrowserServer, pid: number, force: boolean): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    const proc = server.process();
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once("exit", () => resolve());
  });
  if (force) await server.kill().catch(() => {});
  else await Promise.race([server.close().catch(() => {}), delay(5_000)]);
  if (!(await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]))) await server.kill().catch(() => {});
  await exited;
  if (!(await killGroup(pid))) throw new Error(`Browser process group ${pid} is still running after SIGKILL`);
}

// Windows has no process groups: there a "group" is the leader's process tree, ended with taskkill /T.
const WINDOWS = process.platform === "win32";

function groupAlive(pgid: number): boolean {
  try {
    process.kill(WINDOWS ? pgid : -pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Waits briefly for the group to exit on its own, then SIGKILLs it. True once no member is left. */
export async function killGroup(pgid: number): Promise<boolean> {
  for (let i = 0; i < 20 && groupAlive(pgid); i++) await delay(50);
  for (let i = 0; i < 40 && groupAlive(pgid); i++) {
    try {
      if (WINDOWS) await promisify(execFile)("taskkill", ["/PID", String(pgid), "/T", "/F"]);
      else process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone between the check and the kill.
    }
    await delay(50);
  }
  return !groupAlive(pgid);
}

export interface MarkedProcess {
  pid: number;
  pgid: number;
  owner: string;
  runId: string;
}

/** Browser processes carrying our marker switches (Linux: /proc; Windows: CIM via PowerShell; elsewhere: ps). */
export async function listMarkedBrowsers(): Promise<MarkedProcess[]> {
  const rows: { pid: number; pgid: number; args: string }[] = [];
  if (process.platform === "linux") {
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const args = (await readFile(`/proc/${name}/cmdline`, "utf8")).split("\0").join(" ");
        if (!args.includes(OWNER_SWITCH)) continue;
        // Field 5 of /proc/<pid>/stat is the process group; the command name before it may contain spaces.
        const stat = await readFile(`/proc/${name}/stat`, "utf8");
        const pgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
        rows.push({ pid: Number(name), pgid, args });
      } catch {
        // The process exited while we looked.
      }
    }
  } else if (WINDOWS) {
    // A marked process whose parent is not marked leads its tree and stands in for the group leader. The query
    // skips its own PowerShell process, whose command line holds the marker text too.
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${OWNER_SWITCH}*' } | ForEach-Object { "$($_.ProcessId)\`t$($_.ParentProcessId)\`t$($_.CommandLine)" }`;
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { maxBuffer: 16 * 1024 * 1024 });
    const found = stdout.split(/\r?\n/).flatMap((line) => {
      const [pid, parent, ...args] = line.split("\t");
      return pid && /^\d+$/.test(pid) ? [{ pid: Number(pid), parent: Number(parent), args: args.join("\t") }] : [];
    });
    const byPid = new Map(found.map((p) => [p.pid, p]));
    const leader = (p: { pid: number; parent: number }): number => {
      let cur = p;
      // Bounded: a reused pid could make the parent links loop.
      for (let i = 0, up = byPid.get(cur.parent); i < 64 && up && up.pid !== cur.pid; i++, up = byPid.get(cur.parent)) cur = up;
      return cur.pid;
    };
    for (const p of found) rows.push({ pid: p.pid, pgid: leader(p), args: p.args });
  } else {
    const { stdout } = await promisify(execFile)("ps", ["-Ao", "pid=,pgid=,args="], { maxBuffer: 16 * 1024 * 1024 });
    for (const line of stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m && m[3]!.includes(OWNER_SWITCH)) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), args: m[3]! });
    }
  }
  return rows.map(({ pid, pgid, args }) => ({
    pid,
    pgid,
    owner: new RegExp(`${OWNER_SWITCH}(\\S+)`).exec(args)?.[1] ?? "",
    runId: new RegExp(`${RUN_SWITCH}(\\S+)`).exec(args)?.[1] ?? "",
  }));
}

/**
 * Kills leftover browsers whose owner `isStale` says is gone (e.g. a worker that was SIGKILLed).
 * Never touches browsers of a live owner, so several workers can share a host. Returns the killed run ids.
 */
export async function sweepBrowsers(isStale: (owner: string) => boolean): Promise<string[]> {
  const killed = new Set<string>();
  for (const p of await listMarkedBrowsers()) {
    if (!isStale(p.owner)) continue;
    // Only a group leader's group is ours to kill; anything else gets just its own process killed.
    if (p.pgid === p.pid) await killGroup(p.pgid);
    else {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    killed.add(p.runId);
  }
  return [...killed];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
