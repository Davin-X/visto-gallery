import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLibraryFolder } from "../../test/fixtures";
import { useSourceActions } from "./useSourceActions";

const mocks = vi.hoisted(() => {
  const library = {
    activeAlbum: null as string | null,
    folders: [] as unknown[],
    setBusy: vi.fn(),
    setProgress: vi.fn(),
    loadLibrary: vi.fn(async () => {}),
    loadFolders: vi.fn(async () => {}),
  };
  return {
    library,
    scan: vi.fn(async () => ({ discoveredCount: 2, cancelled: false })),
    cancelScan: vi.fn(async () => {}),
  };
});

vi.mock("../../engine/commands/tauri", () => ({
  tauri: { library: { scan: mocks.scan, cancelScan: mocks.cancelScan } },
}));

vi.mock("../../engine/stores", () => {
  const useLibraryStore = (selector: (state: typeof mocks.library) => unknown) =>
    selector(mocks.library);
  (useLibraryStore as unknown as { getState: () => typeof mocks.library }).getState = () =>
    mocks.library;
  return { useLibraryStore };
});

function renderSourceActions() {
  return renderHook(() =>
    useSourceActions({
      screen: "Albums",
      showNotice: vi.fn(),
      showErrorNotice: vi.fn(),
      refreshLibraryStats: vi.fn(),
    }),
  );
}

describe("useSourceActions rescans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.library.folders = [
      makeLibraryFolder({ path: "/a", name: "a" }),
      makeLibraryFolder({ path: "/b", name: "b" }),
    ];
  });

  it("rescanning one source leaves other running scans alone", async () => {
    const { result } = renderSourceActions();
    await act(() => result.current.rescanSource(makeLibraryFolder({ path: "/a", name: "a" })));

    expect(mocks.scan).toHaveBeenCalledWith("/a", true);
    expect(mocks.cancelScan).not.toHaveBeenCalled();
  });

  it("rescanning every source leaves other running scans alone", async () => {
    const { result } = renderSourceActions();
    await act(() => result.current.rescanSources());

    expect(mocks.scan).toHaveBeenCalledTimes(2);
    expect(mocks.cancelScan).not.toHaveBeenCalled();
  });
});
