import { describe, expect, it, vi } from "vitest";
import { restoreScrollOffset } from "./scrollRestore";

describe("restoreScrollOffset", () => {
  it("scrolls directly to an off-screen virtualized row before revealing the tile", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });

    const scrollTo = vi.fn();
    const container = {
      clientHeight: 600,
      scrollTo,
      querySelector: vi.fn(() => null),
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    } as unknown as HTMLElement;
    const restoringRef = { current: false };
    const itemIds = Array.from({ length: 100 }, (_, i) => `item-${i}`);

    // item-80 is at row 20 (20 * 250 = 5000px), well outside saved scrollTop = 0.
    restoreScrollOffset(container, 0, "item-80", restoringRef, {
      columns: 4,
      rowStride: 250,
      itemIds,
    });

    expect(restoringRef.current).toBe(true);
    frames.shift()?.(0);
    expect(scrollTo).toHaveBeenCalledWith({ top: 4825 });

    frames.shift()?.(16);
    expect(restoringRef.current).toBe(false);
    vi.unstubAllGlobals();
  });
});
