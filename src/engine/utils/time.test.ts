/// <reference types="vitest/globals" />
import { formatDuration } from "../../engine/utils/time";

test("formatDuration basic", () => {
  expect(formatDuration(0)).toBe("0:00");
  expect(formatDuration(65)).toBe("1:05");
  expect(formatDuration(3661)).toBe("1:01:01");
  expect(formatDuration(-1)).toBe("0:00");
  expect(formatDuration(NaN)).toBe("0:00");
});