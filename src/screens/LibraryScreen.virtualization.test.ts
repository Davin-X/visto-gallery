/// <reference types="vitest/globals" />
import { calculateVirtualGridWindow } from "./LibraryScreen";

test("the virtual grid window never mounts more than 480 items", () => {
  const itemCount = 100_000;

  // Exercise the top, middle, and end of a very large library at several
  // plausible column counts. The DOM cap must not depend on viewport width.
  for (const columns of [1, 3, 8, 16, 32]) {
    for (const scrollTop of [0, 20_000, 5_000_000]) {
      const window = calculateVirtualGridWindow(
        itemCount,
        columns,
        240,
        16,
        scrollTop,
        1_800,
      );
      expect(window.endIndex - window.startIndex).toBeLessThanOrEqual(480);
      expect(window.startIndex).toBeGreaterThanOrEqual(0);
      expect(window.endIndex).toBeLessThanOrEqual(itemCount);
    }
  }
});

test("the virtual grid preserves the scroll height around a middle window", () => {
  const window = calculateVirtualGridWindow(10_000, 4, 200, 16, 50_000, 800);

  expect(window.startIndex).toBeGreaterThan(0);
  expect(window.topSpacer).toBeGreaterThan(0);
  expect(window.bottomSpacer).toBeGreaterThan(0);
});
