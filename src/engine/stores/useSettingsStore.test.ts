/// <reference types="vitest/globals" />
import { vi } from "vitest";
import { act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ listen: vi.fn() })),
}));

vi.mock("../../commands/tauri", () => ({
  tauri: {
    settings: {
      get: vi.fn().mockResolvedValue({}),
      save: vi.fn().mockResolvedValue({}),
    },
  },
}));

import {
  useSettingsStore,
  resetPendingSettingsSave,
  flushSettingsSaves,
  debugLog,
  shouldLogDebug,
} from "../../engine/stores/useSettingsStore";

test("settings hydrate and update", async () => {
  resetPendingSettingsSave();
  await act(async () => {
    await useSettingsStore.getState().hydrate();
  });
  expect(useSettingsStore.getState()._hydrated).toBe(true);
  await act(async () => {
    await useSettingsStore.getState().update("appearance", "dark");
  });
  expect(useSettingsStore.getState().appearance).toBe("dark");
  flushSettingsSaves();
});

test("automatic update checks are opt-in by default", async () => {
  resetPendingSettingsSave();
  const { defaultSettings } = await import("../types/settings");

  expect(defaultSettings.checkForUpdatesOnLaunch).toBe(false);
  await act(async () => {
    await useSettingsStore.getState().hydrate();
  });
  expect(useSettingsStore.getState().checkForUpdatesOnLaunch).toBe(false);
});

test("debug logging stays quiet unless the setting is on", () => {
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  try {
    expect(shouldLogDebug(false)).toBe(false);
    expect(shouldLogDebug(true)).toBe(true);

    useSettingsStore.setState({ enableDebugLogging: false });
    debugLog("hidden diagnostic");
    expect(debug).not.toHaveBeenCalled();

    useSettingsStore.setState({ enableDebugLogging: true });
    debugLog("visible diagnostic", { attempts: 2 });
    expect(debug).toHaveBeenCalledWith("[VistoGallery]", "visible diagnostic", { attempts: 2 });
  } finally {
    debug.mockRestore();
    useSettingsStore.setState({ enableDebugLogging: false });
  }
});
