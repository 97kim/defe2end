// Slack message text for a delivery payload (stage 5 contract section 5). Pure: no I/O, no secrets in, none out.
// The payload shapes are `notificationPayloadSchema` in packages/shared; this package does not depend on it,
// so the fields read here are typed loosely and missing ones are skipped.

export type MessageLocale = "en" | "ko";

const WORDS = {
  en: {
    status: { passed: "Passed", failed: "Failed", error: "Error", cancelled: "Cancelled", timed_out: "Timed out", queued: "Queued", running: "Running" } as Record<string, string>,
    fire: { missed: "Missed schedule", refused: "Schedule refused", error: "Schedule error" } as Record<string, string>,
    environment: "Environment",
    origin: "From",
    schedule: "schedule",
    bot: "bot",
    duration: "Duration",
    warnings: "warnings",
    step: "Step",
    open: "Open result",
    fix: "Open schedule",
    reason: "Reason",
    missedTimes: "missed times",
    group: "Group run",
    failures: "Failures",
    report: "Daily report",
    runs: "runs",
    passRate: "pass rate",
    noRuns: "No runs in this period.",
    noRunsEnabled: (n: number) => `*No runs in this period, but ${n} schedule(s) are enabled.* Check the worker and the schedules.`,
    newlyFailing: "Newly failing",
    stillFailing: "Still failing",
    inARow: "in a row",
    schedules: (m: number, s: number, r: number) => `Schedules: ${m} missed, ${s} skipped (overlap), ${r} refused`,
    dashboard: "Dashboard",
    test: (name: string) => `Test message from defE2End for webhook "${name}". Notifications will arrive here.`,
  },
  ko: {
    status: { passed: "통과", failed: "실패", error: "오류", cancelled: "취소", timed_out: "시간 초과", queued: "대기", running: "실행 중" } as Record<string, string>,
    fire: { missed: "놓친 예약", refused: "예약 거절", error: "예약 오류" } as Record<string, string>,
    environment: "환경",
    origin: "출처",
    schedule: "스케줄",
    bot: "봇",
    duration: "소요 시간",
    warnings: "경고",
    step: "스텝",
    open: "결과 보기",
    fix: "스케줄 열기",
    reason: "사유",
    missedTimes: "회 놓침",
    group: "그룹 실행",
    failures: "실패 목록",
    report: "일일 리포트",
    runs: "회 실행",
    passRate: "통과율",
    noRuns: "이 기간에 실행이 없어요.",
    noRunsEnabled: (n: number) => `*이 기간에 실행이 없지만 켜진 스케줄이 ${n}개 있어요.* worker와 스케줄을 확인하세요.`,
    newlyFailing: "새로 실패",
    stillFailing: "연속 실패",
    inARow: "회 연속",
    schedules: (m: number, s: number, r: number) => `예약: 놓침 ${m}, 건너뜀(겹침) ${s}, 거절 ${r}`,
    dashboard: "대시보드",
    test: (name: string) => `defE2End 테스트 메시지예요. 웹훅 "${name}"의 알림이 여기로 와요.`,
  },
};

type Loose = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? v : null);

/** Slack mrkdwn escaping: names and reasons come from users. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function link(url: unknown, label: string): string | null {
  const u = str(url);
  return u ? `<${u}|${label}>` : null;
}

function originText(origin: unknown, w: (typeof WORDS)["en"]): string {
  const o = (origin ?? {}) as Loose;
  if (o.kind === "schedule") return `${w.schedule} ${esc(str(o.name))}`;
  if (o.kind === "bot") return `${w.bot} ${esc(str(o.name))}`;
  return esc(str(o.name)) || "-";
}

function stepText(step: unknown, w: (typeof WORDS)["en"]): string | null {
  if (!step || typeof step !== "object") return null;
  const s = step as Loose;
  const reason = str(s.reason);
  return `${w.step} ${num(s.number) ?? "?"} ${esc(str(s.name))}${reason ? `: ${esc(reason.slice(0, 300))}` : ""}`;
}

/** The Slack request body (`{ text }`) for a stored payload. */
export function buildSlackMessage(payload: unknown, locale: MessageLocale = "en"): { text: string } {
  const w = WORDS[locale];
  const p = (payload ?? {}) as Loose;
  const status = (s: unknown) => w.status[str(s)] ?? str(s);
  const lines: (string | null)[] = [];
  switch (p.kind) {
    case "run": {
      const warnings = num(p.warningCount) ?? 0;
      lines.push(`*${status(p.status)}* ${esc(str(p.scenarioName))}${warnings > 0 ? ` (${warnings} ${w.warnings})` : ""}`);
      lines.push(`${w.environment}: ${esc(str(p.environmentName))} · ${w.origin}: ${originText(p.origin, w)} · ${w.duration}: ${formatDuration(num(p.durationMs))}`);
      lines.push(stepText(p.failedStep, w));
      lines.push(link(p.url, w.open));
      break;
    }
    case "group": {
      const counts = (p.counts ?? {}) as Record<string, number>;
      lines.push(`*${status(p.status)}* ${w.group} · ${Object.entries(counts).map(([k, v]) => `${status(k)} ${v}`).join(", ")}`);
      lines.push(`${w.environment}: ${esc(str(p.environmentName))} · ${w.origin}: ${originText(p.origin, w)} · ${w.duration}: ${formatDuration(num(p.durationMs))}`);
      const failures = Array.isArray(p.failures) ? (p.failures as Loose[]) : [];
      if (failures.length) {
        lines.push(`${w.failures}:`);
        for (const f of failures.slice(0, 10)) {
          const step = stepText(f.failedStep, w);
          lines.push(`• ${status(f.status)} ${esc(str(f.scenarioName))}${step ? ` — ${step}` : ""}`);
        }
      }
      lines.push(link(p.url, w.open));
      break;
    }
    case "scheduleFire": {
      const count = num(p.missedCount);
      lines.push(`*${w.fire[str(p.status)] ?? str(p.status)}* ${esc(str(p.scheduleName))}${count ? ` (${count}${locale === "ko" ? "" : " "}${w.missedTimes})` : ""}`);
      if (p.reasonCode) lines.push(`${w.reason}: \`${esc(str(p.reasonCode))}\``);
      lines.push(link(p.url, w.fix));
      break;
    }
    case "report": {
      const total = num(p.total) ?? 0;
      lines.push(`*${w.report}* ${str(p.from).slice(0, 16).replace("T", " ")} – ${str(p.to).slice(0, 16).replace("T", " ")} UTC`);
      const sched = (p.schedules ?? {}) as Record<string, number>;
      if (total === 0) {
        lines.push(sched.enabled ? w.noRunsEnabled(sched.enabled) : w.noRuns);
      } else {
        const rate = num(p.passRate);
        const counts = (p.counts ?? {}) as Record<string, number>;
        lines.push(`${total} ${w.runs} · ${w.passRate} ${rate === null ? "-" : `${Math.round(rate * 100)}%`} · ${Object.entries(counts).map(([k, v]) => `${status(k)} ${v}`).join(", ")}`);
        const newly = Array.isArray(p.newlyFailing) ? (p.newlyFailing as Loose[]) : [];
        if (newly.length) lines.push(`${w.newlyFailing}: ${newly.map((x) => `${esc(str(x.scenarioName))} (${esc(str(x.environmentName))})`).join(", ")}`);
        const still = Array.isArray(p.stillFailing) ? (p.stillFailing as Loose[]) : [];
        if (still.length) lines.push(`${w.stillFailing}: ${still.map((x) => `${esc(str(x.scenarioName))} (${esc(str(x.environmentName))}, ${num(x.streak)}${locale === "ko" ? "" : " "}${w.inARow})`).join(", ")}`);
      }
      if (sched.missed || sched.skipped || sched.refused) lines.push(w.schedules(sched.missed ?? 0, sched.skipped ?? 0, sched.refused ?? 0));
      lines.push(link(p.url, w.dashboard));
      break;
    }
    case "test":
      lines.push(w.test(esc(str(p.webhookName))));
      break;
    default:
      lines.push("defE2End");
  }
  return { text: lines.filter((l): l is string => !!l).join("\n") };
}
