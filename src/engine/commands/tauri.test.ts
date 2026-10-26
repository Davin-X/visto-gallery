/// <reference types="vitest/globals" />
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

import { formatBytes, formatDimensions, formatDateShort } from "../../engine/commands/tauri";

test("formatBytes", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1024)).toBe("1.0 KB");
  expect(formatBytes(1048576)).toBe("1.0 MB");
});

test("formatDimensions", () => {
  expect(formatDimensions({ width: 100, height: 200 })).toBe("100 × 200");
  expect(formatDimensions({ width: 0, height: 0 })).toBe("Unavailable");
});

test("formatDateShort", () => {
  const ts = new Date("2024-01-02").getTime();
  expect(formatDateShort(ts)).toContain("2024");
});