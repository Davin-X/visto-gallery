/// <reference types="vitest/globals" />
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const library = {
    activeAlbum: null as string | null,
    setActiveAlbum: vi.fn(),
    setFilter: vi.fn(),
    setQuery: vi.fn(),
    loadAlbumItems: vi.fn(async () => {}),
  };
  const settings = {
    startupView: "library" as "library" | "last",
    openLastFolder: false,
  };
  return { library, settings };
});

const replaceScreen = vi.hoisted(() => vi.fn());

vi.mock("../../engine/stores", () => {
  const useLibraryStore = Object.assign(
    (selector: (state: typeof mocks.library) => unknown) => selector(mocks.library),
    { getState: () => mocks.library },
  );
  const useSettingsStore = (selector: (state: typeof mocks.settings) => unknown) =>
    selector(mocks.settings);
  return { useLibraryStore, useSettingsStore };
});

vi.mock("../useNavigationStore", () => ({
  useNavigationStore: { getState: () => ({ replaceScreen }) },
}));

import type { Screen } from "../screen";
import { LAST_ALBUM_KEY, LAST_SCREEN_KEY, useStartupView } from "./useStartupView";

function renderStartup(screen: Screen = "Library", hydrated = true) {
  return renderHook(
    ({ current, ready }: { current: Screen; ready: boolean }) => useStartupView(current, ready),
    { initialProps: { current: screen, ready: hydrated } },
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.library.activeAlbum = null;
  mocks.library.setActiveAlbum.mockImplementation((album: string) => {
    mocks.library.activeAlbum = album;
  });
  mocks.settings.startupView = "library";
  mocks.settings.openLastFolder = false;
});

describe("useStartupView on launch", () => {
  test("opens the library by default and stores it as the last view", () => {
    renderStartup();

    expect(replaceScreen).toHaveBeenCalledWith("Library");
    expect(localStorage.getItem(LAST_SCREEN_KEY)).toBe("Library");
  });

  test("restores the last screen when asked to", () => {
    localStorage.setItem(LAST_SCREEN_KEY, "Duplicates");
    mocks.settings.startupView = "last";

    renderStartup();

    expect(replaceScreen).toHaveBeenCalledWith("Duplicates");
    expect(localStorage.getItem(LAST_SCREEN_KEY)).toBe("Duplicates");
  });

  test("restores the last album instead of a bare Albums screen", () => {
    localStorage.setItem(LAST_SCREEN_KEY, "Albums");
    localStorage.setItem(LAST_ALBUM_KEY, "Trip");
    mocks.settings.startupView = "last";
    mocks.settings.openLastFolder = true;

    const { rerender } = renderStartup();

    expect(mocks.library.setActiveAlbum).toHaveBeenCalledWith("Trip");
    expect(mocks.library.setFilter).toHaveBeenCalledWith("All");
    expect(mocks.library.setQuery).toHaveBeenCalledWith("");
    expect(mocks.library.loadAlbumItems).toHaveBeenCalledWith("Trip");
    expect(replaceScreen).toHaveBeenCalledWith("Library");

    // The album store update re-renders the app, which records the album view.
    rerender({ current: "Library", ready: true });
    expect(localStorage.getItem(LAST_SCREEN_KEY)).toBe("Albums");
    expect(localStorage.getItem(LAST_ALBUM_KEY)).toBe("Trip");
  });

  test("keeps the album setting off until the user enables it", () => {
    localStorage.setItem(LAST_SCREEN_KEY, "Albums");
    localStorage.setItem(LAST_ALBUM_KEY, "Trip");
    mocks.settings.startupView = "last";

    renderStartup();

    expect(mocks.library.setActiveAlbum).not.toHaveBeenCalled();
    expect(replaceScreen).toHaveBeenCalledWith("Albums");
  });

  test("does not restore a screen that needs an item in context", () => {
    localStorage.setItem(LAST_SCREEN_KEY, "Viewer");
    mocks.settings.startupView = "last";

    renderStartup();

    expect(replaceScreen).toHaveBeenCalledWith("Library");
    expect(localStorage.getItem(LAST_SCREEN_KEY)).toBe("Library");
  });

  test("waits for settings before restoring", () => {
    localStorage.setItem(LAST_SCREEN_KEY, "Settings");
    mocks.settings.startupView = "last";

    const { rerender } = renderStartup("Library", false);
    expect(replaceScreen).not.toHaveBeenCalled();

    rerender({ current: "Library", ready: true });
    expect(replaceScreen).toHaveBeenCalledWith("Settings");
  });
});

describe("useStartupView tracking", () => {
  test("records the first navigation after a default launch", () => {
    const { rerender } = renderStartup();

    rerender({ current: "Settings", ready: true });

    expect(localStorage.getItem(LAST_SCREEN_KEY)).toBe("Settings");
  });

  test("records an album and its screen", () => {
    const { rerender } = renderStartup();

    mocks.library.activeAlbum = "Trip";
    rerender({ current: "Albums", ready: true });

    expect(localStorage.getItem(LAST_SCREEN_KEY)).toBe("Albums");
    expect(localStorage.getItem(LAST_ALBUM_KEY)).toBe("Trip");
  });

  test("does not overwrite the restored view with the pre-restore screen", () => {
    localStorage.setItem(LAST_SCREEN_KEY, "Duplicates");
    mocks.settings.startupView = "last";

    const { rerender } = renderStartup();

    // The restore commit still passes the old screen until the store updates.
    rerender({ current: "Duplicates", ready: true });

    expect(localStorage.getItem(LAST_SCREEN_KEY)).toBe("Duplicates");
  });

  test("ignores transient screens", () => {
    const { rerender } = renderStartup();

    rerender({ current: "Viewer", ready: true });

    expect(localStorage.getItem(LAST_SCREEN_KEY)).toBe("Library");
  });
});
