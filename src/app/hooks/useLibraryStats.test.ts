import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLibraryStats } from "../../test/fixtures";
import { useLibraryStats } from "./useLibraryStats";

const mocks = vi.hoisted(() => ({
  getStats: vi.fn(),
  countsChanged: null as null | (() => void),
  settings: { showNativeLimitWarnings: true },
}));

vi.mock("../../engine/commands/tauri", () => ({
  tauri: { library: { getStats: mocks.getStats } },
  events: {
    onLibraryChanged: vi.fn(async () => () => {}),
    onLibraryCountsChanged: vi.fn(async (callback: () => void) => {
      mocks.countsChanged = callback;
      return () => {};
    }),
  },
}));

vi.mock("../../engine/stores", () => ({
  refreshDraftMeta: vi.fn(async () => {}),
  useSettingsStore: (selector: (state: typeof mocks.settings) => unknown) =>
    selector(mocks.settings),
}));

describe("useLibraryStats large-library warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countsChanged = null;
  });

  it("warns once per launch even as the counts keep changing", async () => {
    mocks.getStats
      .mockResolvedValueOnce(makeLibraryStats({ photos: 12000 }))
      .mockResolvedValueOnce(makeLibraryStats({ photos: 12500 }));
    const showNotice = vi.fn();
    const { result } = renderHook(() => useLibraryStats(showNotice));

    await waitFor(() => expect(result.current.libraryStats.photos).toBe(12000));
    expect(showNotice).toHaveBeenCalledTimes(1);

    // An import adds rows: the counts change and the stats refresh.
    vi.useFakeTimers();
    try {
      act(() => mocks.countsChanged?.());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(result.current.libraryStats.photos).toBe(12500));
    expect(showNotice).toHaveBeenCalledTimes(1);
  });

  it("stays quiet below the threshold", async () => {
    mocks.getStats.mockResolvedValue(makeLibraryStats({ photos: 50 }));
    const showNotice = vi.fn();
    const { result } = renderHook(() => useLibraryStats(showNotice));

    await waitFor(() => expect(result.current.libraryStats.photos).toBe(50));
    expect(showNotice).not.toHaveBeenCalled();
  });
});
