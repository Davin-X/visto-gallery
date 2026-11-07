/// <reference types="vitest/globals" />
import { afterEach, vi } from "vitest";
import { searchShortcutLabel } from "./shortcut";

describe("searchShortcutLabel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("returns ⌘F on macOS platforms", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(searchShortcutLabel()).toBe("⌘F");
  });

  test("returns ⌘F on iOS/iPadOS platforms", () => {
    vi.stubGlobal("navigator", { platform: "iPhone" });
    expect(searchShortcutLabel()).toBe("⌘F");
  });

  test("prefers userAgentData.platform when available", () => {
    vi.stubGlobal("navigator", {
      platform: "Win32",
      userAgentData: { platform: "macOS" },
    });
    expect(searchShortcutLabel()).toBe("⌘F");
  });

  test("returns Ctrl F on non-Apple platforms", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(searchShortcutLabel()).toBe("Ctrl F");
  });

  test("returns ⌘F when navigator is unavailable", () => {
    vi.stubGlobal("navigator", undefined);
    expect(searchShortcutLabel()).toBe("⌘F");
  });
});
