import { describe, expect, it } from "vitest";
import { describeCron } from "./cron-text";

describe("describeCron", () => {
  it("names the common shapes", () => {
    expect(describeCron("* * * * *")).toEqual({ key: "everyMinute" });
    expect(describeCron("*/15 * * * *")).toEqual({ key: "everyNMinutes", values: { n: 15 } });
    expect(describeCron("5 * * * *")).toEqual({ key: "hourly", values: { minute: "05" } });
    expect(describeCron("0 2 * * *")).toEqual({ key: "daily", values: { time: "02:00" } });
    expect(describeCron("30 9 * * 1-5")).toEqual({ key: "weekdays", values: { time: "09:30" } });
    expect(describeCron("0 9 * * 7,1")).toEqual({ key: "weekly", values: { days: [0, 1], time: "09:00" } });
    expect(describeCron("0 0 1 * *")).toEqual({ key: "monthly", values: { day: 1, time: "00:00" } });
  });

  it("leaves the rest as the expression", () => {
    for (const expr of ["0 */2 * * *", "0 0 1 * 1", "0 0 * 1 *", "0 0 * *", "0 25 * * *"]) expect(describeCron(expr)).toBeNull();
  });
});
