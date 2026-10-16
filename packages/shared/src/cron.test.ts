import { describe, expect, it } from "vitest";
import { checkCron, cronTimesBetween, CRON_PREVIEW_COUNT, nextCronTime, nextCronTimes } from "./cron.js";

const iso = (d: Date[]) => d.map((x) => x.toISOString());

describe("cron", () => {
  it("previews the next 5 times in the schedule's time zone", () => {
    const times = nextCronTimes("0 9 * * 1-5", "Asia/Seoul", new Date("2026-10-16T00:00:00Z"), CRON_PREVIEW_COUNT);
    // Fri 16 Oct 09:00 KST = 00:00Z is not after the cursor; then Mon–Fri next week.
    expect(iso(times)).toEqual(["2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z", "2026-10-22T00:00:00.000Z", "2026-10-23T00:00:00.000Z"]);
  });

  it("skips a wall-clock time that doesn't exist on the spring-forward day", () => {
    const times = nextCronTimes("30 2 * * *", "America/New_York", new Date("2026-03-06T12:00:00Z"), 3);
    // 7 Mar 02:30 EST, (8 Mar 02:30 doesn't exist), 9 Mar 02:30 EDT, 10 Mar 02:30 EDT.
    expect(iso(times)).toEqual(["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
  });

  it("runs a time that happens twice on the fall-back day once", () => {
    const times = nextCronTimes("30 1 * * *", "America/New_York", new Date("2026-10-31T12:00:00Z"), 2);
    expect(iso(times)).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  });

  it("refuses expressions that never fire, the wrong number of fields, bad syntax and unknown zones", () => {
    expect(checkCron("0 0 31 2 *", "UTC")).toMatchObject({ ok: false, code: "cron_never" });
    expect(checkCron("0 0 * * * *", "UTC")).toMatchObject({ ok: false, code: "cron_fields" });
    expect(checkCron("61 * * * *", "UTC")).toMatchObject({ ok: false, code: "cron_invalid" });
    expect(checkCron("0 9 * * *", "Mars/Olympus")).toMatchObject({ ok: false, code: "timezone_invalid" });
    expect(checkCron("*/15 * * * *", "Europe/Berlin")).toEqual({ ok: true });
  });

  it("lists every time in a missed stretch, and the next one after it", () => {
    const { times, truncated } = cronTimesBetween("0 * * * *", "UTC", new Date("2026-10-14T00:30:00Z"), new Date("2026-10-14T04:00:00Z"));
    expect(iso(times)).toEqual(["2026-10-14T01:00:00.000Z", "2026-10-14T02:00:00.000Z", "2026-10-14T03:00:00.000Z", "2026-10-14T04:00:00.000Z"]);
    expect(truncated).toBe(false);
    expect(cronTimesBetween("* * * * *", "UTC", new Date(0), new Date(3_600_000), 10).truncated).toBe(true);
    expect(nextCronTime("0 * * * *", "UTC", new Date("2026-10-14T04:00:00Z"))!.toISOString()).toBe("2026-10-14T05:00:00.000Z");
  });
});
