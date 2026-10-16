import type { RunStatus, StepResultStatus } from "@defe2end/shared";
import type { ReactNode, SVGProps } from "react";

// Run-screen atoms (ap-2, s-2, s-4, ap-1 history strip): status icons and badges, durations, short ids.
// No hooks, so server and client components both use them.

function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}
const make = (children: ReactNode) => (p: SVGProps<SVGSVGElement>) => <Icon {...p}>{children}</Icon>;

export const PassIcon = make(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>);
export const FailIcon = make(<><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>);
export const NotRunIcon = make(<><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></>);
export const QueuedIcon = make(<circle cx="12" cy="12" r="9" strokeDasharray="3 3" />);
export const SpinnerIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p} className={`motion-safe:animate-spin ${p.className ?? ""}`}>
    <path d="M21 12a9 9 0 1 1-6.2-8.6" />
  </Icon>
);
/** Infrastructure: a broken plug, never the failure cross (s-4). */
export const InfraIcon = make(<><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 8h3v3M16 16h-3v-3M8 16l3-3M16 8l-3 3" /></>);
export const ClockIcon = make(<><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2M9 2h6" /></>);
export const StopIcon = make(<rect x="5" y="5" width="14" height="14" rx="2" />);
export const RerunIcon = make(<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />);
export const RerunFailedIcon = make(<path d="M3 6h10M3 12h7M3 18h10M17 8l4 4-4 4M21 12h-7" />);
export const SparklesIcon = make(<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2" />);
export const LayersIcon = make(<path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5" />);
export const UserIcon = make(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
export const ServerIcon = make(<><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>);
export const CalendarIcon = make(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></>);
export const PackageIcon = make(<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9" />);
export const HistoryIcon = make(<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" />);
export const TerminalIcon = make(<path d="m5 7 5 5-5 5M12 19h7" />);
export const FileIcon = make(<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6ZM14 3v6h6" />);
export const ChevronIcon = make(<path d="m9 6 6 6-6 6" />);
export const AlertIcon = make(<path d="M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />);

export type StepDisplayStatus = StepResultStatus | "running" | "queued" | "notRun";
type AnyStatus = RunStatus | StepDisplayStatus;

/** Text color per status; the soft wash goes with it for chips and icon boxes. */
export const STATUS_TEXT: Record<AnyStatus, string> = {
  queued: "text-queued",
  running: "text-running",
  passed: "text-pass",
  failed: "text-fail",
  error: "text-error",
  cancelled: "text-cancelled",
  timed_out: "text-timed-out",
  warning: "text-warn",
  skipped: "text-skipped",
  notRun: "text-skipped",
};

export const STATUS_SOFT: Record<AnyStatus, string> = {
  queued: "bg-queued-soft",
  running: "bg-running-soft",
  passed: "bg-pass-soft",
  failed: "bg-fail-soft",
  error: "bg-error-soft",
  cancelled: "bg-cancelled-soft",
  timed_out: "bg-timed-out-soft",
  warning: "bg-timed-out-soft",
  skipped: "bg-bg-subtle",
  notRun: "bg-bg-subtle",
};

/** Solid fill for history-strip cells. */
export const STATUS_FILL: Record<RunStatus, string> = {
  queued: "bg-border-strong",
  running: "bg-running",
  passed: "bg-pass",
  failed: "bg-fail",
  error: "bg-error",
  cancelled: "bg-cancelled/40",
  timed_out: "bg-timed-out",
};

export function StatusIcon({ status, ...props }: { status: AnyStatus } & SVGProps<SVGSVGElement>) {
  switch (status) {
    case "passed":
      return <PassIcon {...props} />;
    case "failed":
      return <FailIcon {...props} />;
    case "error":
      return <InfraIcon {...props} />;
    case "running":
      return <SpinnerIcon {...props} />;
    case "queued":
      return <QueuedIcon {...props} />;
    case "timed_out":
      return <ClockIcon {...props} />;
    case "cancelled":
      return <StopIcon {...props} />;
    case "warning":
      return <AlertIcon {...props} />;
    default:
      return <NotRunIcon {...props} />;
  }
}

/** ds-2 status badge: icon + word, colored by status (never color alone). */
export function StatusBadge({ status, label }: { status: AnyStatus; label: string }) {
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-meta font-semibold ${STATUS_SOFT[status]} ${STATUS_TEXT[status]}`}>
      <StatusIcon status={status} width={14} height={14} />
      {label}
    </span>
  );
}

/** 40ms, 1.2s, 48.2s, 1m 12s, 1h 3m. */
export function formatDuration(ms: number): string {
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The last 8 characters of the id, shown as "#abcd1234". */
export function shortRunId(id: string): string {
  return id.slice(-8);
}

export const stepNumber = (index: number) => String(index + 1).padStart(2, "0");
