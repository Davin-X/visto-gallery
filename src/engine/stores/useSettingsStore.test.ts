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
