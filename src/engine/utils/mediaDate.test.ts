/// <reference types="vitest/globals" />
import { formatCapturedDateTime, formatItemDate, itemMonth, itemTimestamp } from "./mediaDate";

// 2026-07-11 23:30 as recorded by a camera (wall clock, stored as if UTC).
const LATE_CAPTURE = Date.UTC(2026, 6, 11, 23, 30);

test("capture times are shown exactly as the camera recorded them", () => {
  const text = formatCapturedDateTime(LATE_CAPTURE);
  expect(text).toMatch(/11/);
  expect(text).toMatch(/Jul/);
  expect(text).toMatch(/2026/);
  expect(text).toMatch(/11:30|23:30/);
});

test("item dates use a month name, never a numeric day/month order", () => {
  const text = formatItemDate({ capturedAt: LATE_CAPTURE, modifiedAt: 0 });
  expect(text).toMatch(/Jul/);
  expect(text).not.toMatch(/\d+\/\d+\/\d+/);
});

test("capture date wins over modification date", () => {
  expect(itemTimestamp({ capturedAt: 5, modifiedAt: 9 })).toEqual({ ms: 5, wallClock: true });
  expect(itemTimestamp({ capturedAt: null, modifiedAt: 9 })).toEqual({ ms: 9, wallClock: false });
});

test("timeline months for captures do not shift with the local time zone", () => {
  // Late on the last day of a month must stay in that month.
  const endOfJuly = Date.UTC(2026, 6, 31, 23, 59);
  expect(itemMonth({ capturedAt: endOfJuly, modifiedAt: 0 }).key).toBe("2026-6");
  expect(itemMonth({ capturedAt: endOfJuly, modifiedAt: 0 }).label).toMatch(/July 2026/);
});
