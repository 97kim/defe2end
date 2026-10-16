// `node dist/sandbox-check.js`: proves the Chromium sandbox is on where the worker runs (contract section 8).
// Starts a real run's browser with the sandbox requested, then reads /proc: every renderer must sit in a
// seccomp-bpf filter and in user and PID namespaces of its own. Exits 1 (and says why) otherwise.
import { readFile, readlink } from "node:fs/promises";
import { listMarkedBrowsers, runPlan } from "@defe2end/runner";
import { DEFAULT_DEVICE, type ArtifactSink } from "@defe2end/shared";

export interface SandboxReport {
  sandboxed: boolean;
  browserArgs: string;
  renderers: { pid: number; seccomp: string; ownUserNamespace: boolean; ownPidNamespace: boolean }[];
  problems: string[];
}

const nothingStored: ArtifactSink = {
  async open() {
    return { write: async () => {}, complete: async () => Promise.reject(new Error("not stored")), abort: async () => {} };
  },
};

async function processInfo(pid: number) {
  const [cmdline, status, userNs, pidNs] = await Promise.all([
    readFile(`/proc/${pid}/cmdline`, "utf8"),
    readFile(`/proc/${pid}/status`, "utf8"),
    readlink(`/proc/${pid}/ns/user`),
    readlink(`/proc/${pid}/ns/pid`),
  ]);
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const pgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  return { args: cmdline.split("\0").join(" "), seccomp: /^Seccomp:\s*(\d)/m.exec(status)?.[1] ?? "?", userNs, pidNs, pgid };
}

async function inspect(runId: string): Promise<SandboxReport> {
  const [browser] = (await listMarkedBrowsers()).filter((p) => p.runId === runId);
  if (!browser) return { sandboxed: false, browserArgs: "", renderers: [], problems: ["browser process not found"] };
  const root = await processInfo(browser.pid);
  const renderers: SandboxReport["renderers"] = [];
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const info = await processInfo(Number(name)).catch(() => null);
    if (!info || info.pgid !== browser.pgid || !info.args.includes("--type=renderer")) continue;
    renderers.push({ pid: Number(name), seccomp: info.seccomp, ownUserNamespace: info.userNs !== root.userNs, ownPidNamespace: info.pidNs !== root.pidNs });
  }
  const problems: string[] = [];
  if (root.args.includes("--no-sandbox")) problems.push("browser started with --no-sandbox");
  if (renderers.length === 0) problems.push("no renderer process found");
  for (const r of renderers) {
    if (r.seccomp !== "2") problems.push(`renderer ${r.pid} has no seccomp-bpf filter (Seccomp: ${r.seccomp})`);
    if (!r.ownUserNamespace) problems.push(`renderer ${r.pid} shares the browser's user namespace`);
    if (!r.ownPidNamespace) problems.push(`renderer ${r.pid} shares the browser's PID namespace`);
  }
  return { sandboxed: problems.length === 0, browserArgs: root.args, renderers, problems };
}

export async function checkSandbox(): Promise<SandboxReport> {
  if (process.platform !== "linux") throw new Error("The sandbox check reads /proc and runs on Linux only");
  const runId = `sandbox-check-${process.pid}`;
  const controller = new AbortController();
  let report: SandboxReport | undefined;
  let launchError: string | undefined;
  const run = runPlan(
    {
      runId,
      baseUrl: "http://localhost",
      // A step that keeps the browser (and its blank page's renderer) up while /proc is read.
      steps: [{ id: "hold", action: "waitForSelector", selector: "#never-shown", timeout: 20_000 }],
      variables: {},
      device: DEFAULT_DEVICE,
      stepTimeoutMs: 20_000,
      network: { blockPrivateNetworks: false },
      capture: { video: false, traceOnFailure: false },
    },
    {
      sink: nothingStored,
      signal: controller.signal,
      owner: String(process.pid),
      sandbox: true,
      onEvent: async (event) => {
        if (event.type === "stepStarted") {
          await new Promise((r) => setTimeout(r, 1_000));
          report = await inspect(runId);
          controller.abort("cancelled");
        }
      },
    },
  ).then((verdict) => {
    if (verdict.errorCode === "browser_launch_failed") launchError = verdict.errorMessage;
  });
  await run;
  if (launchError) return { sandboxed: false, browserArgs: "", renderers: [], problems: [`browser did not start with the sandbox: ${launchError}`] };
  return report ?? { sandboxed: false, browserArgs: "", renderers: [], problems: ["the run ended before the check"] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await checkSandbox();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.sandboxed ? 0 : 1);
}
