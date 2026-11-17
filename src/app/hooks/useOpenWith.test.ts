import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLibraryFolder, makeMediaItem } from "../../test/fixtures";
import type { OpenPath, ScanResult } from "../../engine/types/commands";
import type { NoticeAction } from "../types";
import { useOpenWith } from "./useOpenWith";

const mocks = vi.hoisted(() => ({
  takePendingOpenPaths: vi.fn<() => Promise<OpenPath[]>>(),
  onOpenPathsPending: vi.fn(async (_callback: () => void) => () => {}),
  includeItem: vi.fn(),
  setScreen: vi.fn(),
  library: { folders: [] as Array<{ path: string }> },
  wake: null as null | (() => void),
}));

vi.mock("../../engine/commands/tauri", () => ({
  tauri: { library: { takePendingOpenPaths: mocks.takePendingOpenPaths } },
  events: {
    onOpenPathsPending: async (callback: () => void) => {
      mocks.wake = callback;
      return mocks.onOpenPathsPending(callback);
    },
  },
}));

vi.mock("../../engine/stores", () => {
  const useLibraryStore = Object.assign(
    (selector: (state: typeof mocks.library) => unknown) => selector(mocks.library),
    { getState: () => ({ ...mocks.library, includeItem: mocks.includeItem }) },
  );
  return { useLibraryStore };
});

vi.mock("../useNavigationStore", () => ({ setScreen: mocks.setScreen }));

function scanResult(paths: string[]): ScanResult {
  return {
    items: paths.map((path, index) => makeMediaItem({ id: `item-${index}`, path, name: "a.jpg" })),
    discoveredCount: paths.length,
    removedCount: 0,
    cancelled: false,
    albums: [],
    tags: [],
    totalSize: 0,
    duration: 0,
  };
}

function renderOpenWith(overrides: { folders?: string[] } = {}) {
  mocks.library.folders = (overrides.folders ?? []).map((path) => makeLibraryFolder({ path }));
  const importPaths = vi.fn(async (paths: string[]) => scanResult(paths));
  const openViewer = vi.fn();
  const showNotice = vi.fn();
  const showErrorNotice = vi.fn();
  const rendered = renderHook(() =>
    useOpenWith({ openViewer, importPaths, showNotice, showErrorNotice }),
  );
  return { ...rendered, importPaths, openViewer, showNotice, showErrorNotice };
}

function noticeAction(showNotice: ReturnType<typeof vi.fn>): NoticeAction | undefined {
  return showNotice.mock.calls.find((call) => call[2])?.[2] as NoticeAction | undefined;
}

describe("useOpenWith", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.wake = null;
    mocks.takePendingOpenPaths.mockResolvedValue([]);
  });

  it("plays a drained file and offers to add its folder", async () => {
    mocks.takePendingOpenPaths.mockResolvedValue([
      { path: "/Users/me/Pictures/a.jpg", isDir: false },
    ]);
    const { importPaths, openViewer, showNotice } = renderOpenWith();

    await waitFor(() => expect(importPaths).toHaveBeenCalledWith(["/Users/me/Pictures/a.jpg"]));
    expect(openViewer).toHaveBeenCalledWith("item-0");
    expect(mocks.includeItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "item-0", path: "/Users/me/Pictures/a.jpg" }),
    );

    const action = noticeAction(showNotice);
    expect(action?.label).toBe("Add folder");
    action?.run();
    expect(importPaths).toHaveBeenLastCalledWith(["/Users/me/Pictures"]);
  });

  it("does not offer a folder that is already a source", async () => {
    mocks.takePendingOpenPaths.mockResolvedValue([
      { path: "/Users/me/Pictures/a.jpg", isDir: false },
    ]);
    const { importPaths, openViewer, showNotice } = renderOpenWith({
      folders: ["/Users/me/Pictures"],
    });

    await waitFor(() => expect(openViewer).toHaveBeenCalled());
    expect(importPaths).toHaveBeenCalledTimes(1);
    expect(noticeAction(showNotice)).toBeUndefined();
  });

  it("indexes a drained folder and lands on the library", async () => {
    mocks.takePendingOpenPaths.mockResolvedValue([{ path: "/Users/me/Pictures", isDir: true }]);
    const { importPaths, openViewer } = renderOpenWith();

    await waitFor(() => expect(importPaths).toHaveBeenCalledWith(["/Users/me/Pictures"]));
    expect(mocks.setScreen).toHaveBeenCalledWith("Library");
    expect(openViewer).not.toHaveBeenCalled();
  });

  it("ignores an empty queue", async () => {
    const { importPaths, openViewer } = renderOpenWith();

    await waitFor(() => expect(mocks.takePendingOpenPaths).toHaveBeenCalled());
    expect(importPaths).not.toHaveBeenCalled();
    expect(openViewer).not.toHaveBeenCalled();
  });

  it("drains again when Rust says a path arrived", async () => {
    const { importPaths, openViewer } = renderOpenWith();
    await waitFor(() => expect(mocks.wake).not.toBeNull());

    mocks.takePendingOpenPaths.mockResolvedValue([
      { path: "/Users/me/Pictures/b.jpg", isDir: false },
    ]);
    mocks.wake?.();

    await waitFor(() => expect(openViewer).toHaveBeenCalledWith("item-0"));
    expect(importPaths).toHaveBeenCalledWith(["/Users/me/Pictures/b.jpg"]);
  });
});
