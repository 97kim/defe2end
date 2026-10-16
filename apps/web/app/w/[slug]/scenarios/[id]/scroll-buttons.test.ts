import { expect, it } from "vitest";
import { scrollButtons } from "./scroll-buttons";

it("shows ↑ away from the top and ↓ away from the bottom, neither when nothing scrolls", () => {
  expect(scrollButtons({ scrollTop: 0, scrollHeight: 600, clientHeight: 600 })).toEqual({ showTop: false, showBottom: false });
  expect(scrollButtons({ scrollTop: 0, scrollHeight: 2000, clientHeight: 600 })).toEqual({ showTop: false, showBottom: true });
  expect(scrollButtons({ scrollTop: 700, scrollHeight: 2000, clientHeight: 600 })).toEqual({ showTop: true, showBottom: true });
  expect(scrollButtons({ scrollTop: 1380, scrollHeight: 2000, clientHeight: 600 })).toEqual({ showTop: true, showBottom: false });
  expect(scrollButtons({ scrollTop: 30, scrollHeight: 650, clientHeight: 600 })).toEqual({ showTop: false, showBottom: false });
});
