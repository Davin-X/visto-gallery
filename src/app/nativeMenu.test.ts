/// <reference types="vitest/globals" />
import { describe, expect, test, vi } from "vitest";
import { dispatchNativeMenuEvent } from "./nativeMenu";
import { isExportShortcut } from "./shortcuts";

function handlers() {
  return {
    importFolder: vi.fn(),
    importFiles: vi.fn(),
    exportToBatch: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleInspector: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    showAbout: vi.fn(),
    checkUpdates: vi.fn(),
    showSettings: vi.fn(),
    showShortcuts: vi.fn(),
  };
}

describe("native menu dispatch", () => {
  test("File > Export… reaches the Batch Export action", () => {
    const actions = handlers();
    expect(dispatchNativeMenuEvent("menu-export", actions)).toBe(true);
    expect(actions.exportToBatch).toHaveBeenCalledTimes(1);
    expect(actions.importFolder).not.toHaveBeenCalled();
    expect(actions.importFiles).not.toHaveBeenCalled();
  });

  test("File > Settings… and Help > Keyboard Shortcuts… reach their actions", () => {
    const actions = handlers();
    expect(dispatchNativeMenuEvent("menu-settings", actions)).toBe(true);
    expect(actions.showSettings).toHaveBeenCalledTimes(1);

    expect(dispatchNativeMenuEvent("menu-shortcuts", actions)).toBe(true);
    expect(actions.showShortcuts).toHaveBeenCalledTimes(1);
  });

  test("unknown events are ignored for forward compatibility", () => {
    const actions = handlers();
    expect(dispatchNativeMenuEvent("menu-from-the-future", actions)).toBe(false);
    expect(Object.values(actions).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  test("Cmd/Ctrl+E is the same export shortcut", () => {
    expect(isExportShortcut({ metaKey: true, ctrlKey: false, key: "e" })).toBe(true);
    expect(isExportShortcut({ metaKey: false, ctrlKey: true, key: "E" })).toBe(true);
    expect(isExportShortcut({ metaKey: true, ctrlKey: false, key: "e", shiftKey: true })).toBe(
      false,
    );
    expect(isExportShortcut({ metaKey: true, ctrlKey: false, key: "e", altKey: true })).toBe(false);
    expect(isExportShortcut({ metaKey: false, ctrlKey: false, key: "e" })).toBe(false);
  });
});
