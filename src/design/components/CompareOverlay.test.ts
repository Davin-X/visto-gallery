/// <reference types="vitest/globals" />
import {
  clampPan,
  clampZoom,
  describeDifferences,
  selectVisibleRows,
  MAX_ZOOM,
  MIN_ZOOM,
} from "./CompareOverlay";

test("zoom stays inside the allowed range", () => {
  expect(clampZoom(0.2)).toBe(MIN_ZOOM);
  expect(clampZoom(1.5)).toBe(1.5);
  expect(clampZoom(50)).toBe(MAX_ZOOM);
  expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
});

test("pan is pinned to the image edges at the current zoom", () => {
  const box = { width: 400, height: 200 };
  // No zoom means nothing can move: the image already fits the frame.
  expect(clampPan({ x: 50, y: -50 }, 1, box)).toEqual({ x: 0, y: 0 });
  // At 2x the image is twice the box, so dragging is bounded by half a box.
  expect(clampPan({ x: 500, y: -500 }, 2, box)).toEqual({ x: 200, y: -100 });
  expect(clampPan({ x: 30, y: 20 }, 2, box)).toEqual({ x: 30, y: 20 });
});

test("difference count reads as natural English", () => {
  expect(describeDifferences(0)).toBe("Identical metadata");
  expect(describeDifferences(1)).toBe("1 field differs");
  expect(describeDifferences(3)).toBe("3 fields differ");
});

test("differences-only drops rows that match, keeps everything otherwise", () => {
  const rows = [
    { label: "File", differs: true },
    { label: "Size", differs: false },
    { label: "Camera", differs: false },
  ];
  expect(selectVisibleRows(rows, true).map((row) => row.label)).toEqual(["File"]);
  expect(selectVisibleRows(rows, false)).toHaveLength(3);
  expect(selectVisibleRows([{ label: "Camera", differs: false }], true)).toHaveLength(0);
});
