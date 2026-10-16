// A cron expression in words for the list and the editor. Covers the common shapes; anything else (steps in
// hours, day-of-month together with weekdays — cron ORs them —, lists of months) returns null and the
// expression is shown as it is.

export type CronText =
  | { key: "everyMinute" }
  | { key: "everyNMinutes"; values: { n: number } }
  | { key: "hourly"; values: { minute: string } }
  | { key: "daily"; values: { time: string } }
  | { key: "weekdays"; values: { time: string } }
  | { key: "weekly"; values: { days: number[]; time: string } }
  | { key: "monthly"; values: { day: number; time: string } };

const num = (field: string, max: number) => (/^\d+$/.test(field) && Number(field) <= max ? Number(field) : null);

export function describeCron(expr: string): CronText | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (month !== "*") return null;
  if (hour === "*" && dom === "*" && dow === "*") {
    if (minute === "*") return { key: "everyMinute" };
    const step = /^\*\/(\d+)$/.exec(minute);
    if (step) return { key: "everyNMinutes", values: { n: Number(step[1]) } };
    const m = num(minute, 59);
    return m === null ? null : { key: "hourly", values: { minute: String(m).padStart(2, "0") } };
  }
  const m = num(minute, 59);
  const h = num(hour, 23);
  if (m === null || h === null) return null;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dom === "*" && dow === "*") return { key: "daily", values: { time } };
  if (dom === "*") {
    if (dow === "1-5") return { key: "weekdays", values: { time } };
    const days = dow.split(",").map((d) => num(d, 7));
    if (days.some((d) => d === null)) return null;
    return { key: "weekly", values: { days: [...new Set(days.map((d) => d! % 7))].sort(), time } };
  }
  const day = num(dom, 31);
  if (dow === "*" && day !== null && day >= 1) return { key: "monthly", values: { day, time } };
  return null;
}
