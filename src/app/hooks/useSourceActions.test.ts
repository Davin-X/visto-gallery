import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLibraryFolder } from "../../test/fixtures";
import { splitWithoutOverlap, useSourceActions } from "./useSourceActions";

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

describe("splitWithoutOverlap", () => {
  const tree: Record<string, { subfolders: string[]; looseMediaCount: number }> = {
    "/d": { subfolders: ["/d/Docs", "/d/Lib", "/d/New"], looseMediaCount: 2 },
    "/d/Lib": { subfolders: ["/d/Lib/A", "/d/Lib/B"], looseMediaCount: 1 },
    "/d/Docs": { subfolders: [], looseMediaCount: 0 },
  };
  const split = async (path: string) => tree[path] ?? { subfolders: [], looseMediaCount: 0 };

  it("skips existing sources and splits folders that hold them", async () => {
    await expect(splitWithoutOverlap("/d", ["/d/Lib/A"], split)).resolves.toEqual({
      sources: ["/d/Docs", "/d/Lib/B", "/d/New"],
      looseMediaCount: 3,
    });
  });

  it("keeps a leaf folder or one already covered by a source", async () => {
    await expect(splitWithoutOverlap("/d/Docs", [], split)).resolves.toEqual({
      sources: ["/d/Docs"],
      looseMediaCount: 0,
    });
    await expect(splitWithoutOverlap("/d/Lib/A/x", ["/d/Lib/A"], split)).resolves.toEqual({
      sources: ["/d/Lib/A/x"],
      looseMediaCount: 0,
    });
  });
});
