/// <reference types="vitest/globals" />
import { describe, expect, test } from "vitest";
import {
  anchoredPan,
  clampPan,
  clampZoom,
  fittedSize,
  MAX_ZOOM,
  MIN_ZOOM,
  oneToOneZoom,
  stepZoom,
  wheelZoomFactor,
} from "./zoom";

describe("viewer zoom", () => {
  test("steps are finer near 100% and stop at the limits", () => {
    expect(stepZoom(100, 1)).toBe(125);
    expect(stepZoom(100, -1)).toBe(75);
    expect(stepZoom(137, 1)).toBe(150);
    expect(stepZoom(137, -1)).toBe(125);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  test("zoom is clamped to its range", () => {
    expect(clampZoom(5)).toBe(MIN_ZOOM);
    expect(clampZoom(5000)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(100);
  });

  test("wheel deltas zoom in when scrolling up and are capped per event", () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
    expect(wheelZoomFactor(1000)).toBeCloseTo(wheelZoomFactor(50));
    // Line-mode deltas (a mouse wheel in some browsers) are scaled to pixels.
    expect(wheelZoomFactor(1, 1)).toBeCloseTo(wheelZoomFactor(16));
  });

  test("anchored zoom keeps the point under the pointer fixed", () => {
    const anchor = { x: 120, y: -40 };
    const from = 100;
    const to = 250;
    const pan = anchoredPan({ x: 0, y: 0 }, anchor, from, to);
    // Image offset under the anchor before and after must match.
    const before = { x: (anchor.x - 0) / from, y: (anchor.y - 0) / from };
    const after = { x: (anchor.x - pan.x) / to, y: (anchor.y - pan.y) / to };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    // Zooming at the centre needs no pan.
    expect(anchoredPan({ x: 0, y: 0 }, { x: 0, y: 0 }, 100, 300)).toEqual({ x: 0, y: 0 });
  });

  test("pan stays inside the zoomed photo and is zero at fit", () => {
    const stage = { width: 800, height: 600 };
    expect(clampPan({ x: 900, y: -900 }, 200, stage)).toEqual({ x: 400, y: -300 });
    expect(clampPan({ x: 50, y: 50 }, 100, stage)).toEqual({ x: 0, y: 0 });
  });

  test("a letterboxed photo only pans once it overflows the stage", () => {
    const stage = { width: 1200, height: 600 };
    // A 3:2 photo fits at 900x600, leaving 150 px bands at each side.
    const content = fittedSize(stage, 3 / 2);
    expect(content).toEqual({ width: 900, height: 600 });
    // At 120% it is 1080 wide: still narrower than the stage, so x stays put.
    expect(clampPan({ x: 80, y: 80 }, 120, stage, content)).toEqual({ x: 0, y: 60 });
    // At 200% it is 1800 wide and may move 300 px either way.
    expect(clampPan({ x: 900, y: 0 }, 200, stage, content).x).toBe(300);
    // Unknown dimensions fall back to the stage box.
    expect(fittedSize(stage, null)).toEqual(stage);
  });

  test("1:1 zoom maps one image pixel to one physical display pixel", () => {
    const stage = { width: 1000, height: 800 };
    // 4000x3000 fits at 1000x750; at 1x DPR 1:1 is 400%, at 2x Retina it is 200%.
    expect(oneToOneZoom(stage, { width: 4000, height: 3000 }, 1)).toBeCloseTo(400);
    expect(oneToOneZoom(stage, { width: 4000, height: 3000 }, 2)).toBeCloseTo(200);
    // Small 800x600 image at 2x DPR is 400 CSS px wide -> 40% of 1000px fitted width.
    expect(oneToOneZoom(stage, { width: 800, height: 600 }, 2)).toBeCloseTo(40);
    // Zero dimensions fall back safely to 100%.
    expect(oneToOneZoom({ width: 0, height: 800 }, { width: 4000, height: 3000 }, 2)).toBe(100);
  });
});
