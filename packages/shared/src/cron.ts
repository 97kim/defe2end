// Schedule times (stage 5 contract sections 1 and 4): one set of functions for saving (check, preview of the
// next 5) and firing, so they always agree. Five-field cron in an IANA time zone, built on `croner`.
// Daylight saving: a wall-clock time that doesn't exist that day is skipped (croner would move it an hour
// later), and a time that happens twice runs once.
import { Cron } from "croner";

export const CRON_PREVIEW_COUNT = 5;
/** How far ahead an expression must fire at least once ("0 0 31 2 *" never does). */
const NEVER_HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000;

export type CronCheck = { ok: true } | { ok: false; code: "cron_fields" | "cron_invalid" | "cron_never" | "timezone_invalid"; message: string };

export function isValidTimeZone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function compile(expr: string, timezone: string): Cron {
  return new Cron(expr, { timezone, paused: true, legacyMode: true });
}

/** Wall-clock fields of `date` in `timezone`, as a UTC instant (a matcher with no daylight saving). */
function wallClockAsUtc(date: Date, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
}

/** Does the wall-clock time of `date` really match the expression? False for croner's shifted DST-gap times. */
function matchesWallClock(utcMatcher: Cron, date: Date, timezone: string): boolean {
  const wall = wallClockAsUtc(date, timezone);
  return utcMatcher.nextRun(new Date(wall - 1000))?.getTime() === wall;
}

/** Validates a schedule's expression and time zone. Five fields only; one that never fires is refused. */
export function checkCron(expr: string, timezone: string, now: Date = new Date()): CronCheck {
  if (!isValidTimeZone(timezone)) return { ok: false, code: "timezone_invalid", message: `Unknown time zone "${timezone}"` };
  if (expr.trim().split(/\s+/).length !== 5) return { ok: false, code: "cron_fields", message: "Use five fields: minute hour day-of-month month day-of-week" };
  let next: Date | null;
  try {
    next = nextCronTime(expr, timezone, now);
  } catch (err) {
    return { ok: false, code: "cron_invalid", message: (err as Error).message.replace(/^CronPattern: /, "") };
  }
  if (!next || next.getTime() - now.getTime() > NEVER_HORIZON_MS) return { ok: false, code: "cron_never", message: "This expression never fires" };
  return { ok: true };
}

/** The first fire time strictly after `after`, or null. Throws on an invalid expression. */
export function nextCronTime(expr: string, timezone: string, after: Date): Date | null {
  return nextCronTimes(expr, timezone, after, 1)[0] ?? null;
}

/** The next `count` fire times strictly after `after` (preview: CRON_PREVIEW_COUNT). */
export function nextCronTimes(expr: string, timezone: string, after: Date, count: number): Date[] {
  const cron = compile(expr, timezone);
  const matcher = compile(expr, "UTC");
  const out: Date[] = [];
  let cursor = after;
  // Each skipped DST-gap time costs one extra step; bound the loop anyway.
  for (let guard = 0; out.length < count && guard < count * 4 + 8; guard++) {
    const next = cron.nextRun(cursor);
    if (!next) break;
    cursor = next;
    if (matchesWallClock(matcher, next, timezone) && (out.length === 0 || next.getTime() > out.at(-1)!.getTime())) out.push(next);
  }
  return out;
}

/**
 * Fire times in `(after, until]`, oldest first, at most `limit` (missed stretches: the first, the last and
 * how many). `truncated` when there were more than `limit`.
 */
export function cronTimesBetween(expr: string, timezone: string, after: Date, until: Date, limit = 10_000): { times: Date[]; truncated: boolean } {
  const times: Date[] = [];
  let cursor = after;
  while (times.length <= limit) {
    const [next] = nextCronTimes(expr, timezone, cursor, 1);
    if (!next || next.getTime() > until.getTime()) return { times, truncated: false };
    times.push(next);
    cursor = next;
  }
  return { times: times.slice(0, limit), truncated: true };
}
