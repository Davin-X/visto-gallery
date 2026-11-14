/// <reference types="vitest/globals" />
import { describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: vi.fn(async () => null),
  getCurrentWindow: vi.fn(() => ({
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 1280, height: 880 })),
    setSize: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
    onMoved: vi.fn(async () => () => {}),
    onResized: vi.fn(async () => () => {}),
  })),
  LogicalSize: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
  PhysicalSize: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
  PhysicalPosition: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
}));

import {
  clampFrameToWorkArea,
  readStoredWindowFrame,
  WINDOW_FRAME_KEY,
  type WindowFrame,
} from "./useWindowState";

const frame: WindowFrame = { x: 100, y: 80, width: 1280, height: 880 };
const work = { position: { x: 0, y: 0 }, size: { width: 1440, height: 900 } };

function storageWith(raw: string | null) {
  return { getItem: (key: string) => (key === WINDOW_FRAME_KEY ? raw : null) };
}

describe("readStoredWindowFrame", () => {
  test("reads a complete frame", () => {
    expect(readStoredWindowFrame(storageWith(JSON.stringify(frame)))).toEqual(frame);
  });

  test("has no frame when nothing was saved", () => {
    expect(readStoredWindowFrame(storageWith(null))).toBeNull();
    expect(readStoredWindowFrame(undefined)).toBeNull();
  });

  test("ignores metadata that is not a usable frame", () => {
    expect(readStoredWindowFrame(storageWith("{not json"))).toBeNull();
    expect(readStoredWindowFrame(storageWith("null"))).toBeNull();
    expect(readStoredWindowFrame(storageWith(JSON.stringify({ x: 0, y: 0 })))).toBeNull();
    expect(readStoredWindowFrame(storageWith(JSON.stringify({ ...frame, width: 0 })))).toBeNull();
    expect(
      readStoredWindowFrame(storageWith(JSON.stringify({ ...frame, height: -10 }))),
    ).toBeNull();
    expect(readStoredWindowFrame(storageWith(JSON.stringify({ ...frame, x: "12" })))).toBeNull();
  });
});

describe("clampFrameToWorkArea", () => {
  test("leaves a frame that already fits alone", () => {
    expect(clampFrameToWorkArea(frame, work)).toEqual(frame);
  });

  test("keeps a titlebar reachable when the frame is past the right or bottom edge", () => {
    expect(clampFrameToWorkArea({ ...frame, x: 2000, y: 1000 }, work)).toEqual({
      ...frame,
      x: 1320,
      y: 820,
    });
  });

  test("pulls an off-screen frame back to the work area origin", () => {
    expect(clampFrameToWorkArea({ ...frame, x: -500, y: -300 }, work)).toEqual({
      ...frame,
      x: 0,
      y: 0,
    });
  });

  test("respects a second monitor that starts to the right", () => {
    const right = { position: { x: 1440, y: 0 }, size: { width: 1920, height: 1080 } };
    expect(
      clampFrameToWorkArea({ ...frame, x: 1200, y: 300, width: 800, height: 600 }, right),
    ).toEqual({ ...frame, x: 1440, y: 300, width: 800, height: 600 });
  });

  test("never hides more than the frame itself", () => {
    const tiny = { x: 4000, y: 4000, width: 60, height: 40 };
    expect(clampFrameToWorkArea(tiny, work)).toEqual({
      ...tiny,
      x: work.size.width - tiny.width,
      y: work.size.height - tiny.height,
    });
  });
});
