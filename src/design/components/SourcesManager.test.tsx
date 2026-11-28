import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLibraryFolder } from "../../test/fixtures";
import { SourcesManager } from "./SourcesManager";

const mocks = vi.hoisted(() => {
  const state = {
    folders: [] as unknown[],
    activeSource: null as string | null,
    busy: false,
    setActiveSource: vi.fn(),
    loadFolders: vi.fn(async () => {}),
    loadLibrary: vi.fn(async () => {}),
    showNotice: vi.fn(),
    showErrorNotice: vi.fn(),
  };
  return {
    state,
    chooseFolder: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
  };
});

vi.mock("../../engine/commands/tauri", () => ({
  formatBytes: (bytes: number) => `${bytes} B`,
  tauri: {
    items: { revealInFinder: vi.fn(async () => {}) },
    rootMap: {
      chooseFolder: mocks.chooseFolder,
      preview: mocks.preview,
      apply: mocks.apply,
    },
  },
}));
vi.mock("../../engine/stores", () => {
  const useLibraryStore = (selector: (state: typeof mocks.state) => unknown) =>
    selector(mocks.state);
  (useLibraryStore as unknown as { getState: () => typeof mocks.state }).getState = () =>
    mocks.state;
  return { useLibraryStore };
});

describe("SourcesManager Locate…", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.folders = [
      makeLibraryFolder({ path: "/Volumes/Old/Photos", name: "Photos", available: false }),
    ];
  });

  it("points a missing source at the folder the user picks", async () => {
    mocks.chooseFolder.mockResolvedValue("/Volumes/New/Photos");
    mocks.preview.mockResolvedValue({ conflictingPaths: [], itemCount: 12 });
    mocks.apply.mockResolvedValue({ updatedItemCount: 12 });
    render(<SourcesManager />);

    fireEvent.click(screen.getByRole("button", { name: "Locate…" }));

    await waitFor(() =>
      expect(mocks.apply).toHaveBeenCalledWith("/Volumes/Old/Photos", "/Volumes/New/Photos"),
    );
    expect(mocks.state.loadFolders).toHaveBeenCalled();
    expect(mocks.state.loadLibrary).toHaveBeenCalled();
    expect(mocks.state.showNotice).toHaveBeenCalledWith(expect.stringContaining("12 items"));
  });

  it("changes nothing when the new folder conflicts with the catalog", async () => {
    mocks.chooseFolder.mockResolvedValue("/Volumes/New/Photos");
    mocks.preview.mockResolvedValue({ conflictingPaths: ["/Volumes/New/Photos/a.jpg"] });
    render(<SourcesManager />);

    fireEvent.click(screen.getByRole("button", { name: "Locate…" }));

    await waitFor(() => expect(mocks.state.showNotice).toHaveBeenCalled());
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});

describe("SourcesManager sorting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.folders = [
      makeLibraryFolder({
        path: "/Volumes/Photos/Zeta",
        name: "Zeta",
        itemCount: 2,
        totalSize: 20,
      }),
      makeLibraryFolder({
        path: "/Volumes/Photos/Alpha",
        name: "Alpha",
        itemCount: 10,
        totalSize: 3,
      }),
      makeLibraryFolder({
        path: "/Volumes/Photos/Album 10",
        name: "Album 10",
        itemCount: 5,
        totalSize: 12,
      }),
      makeLibraryFolder({
        path: "/Volumes/Photos/Album 2",
        name: "Album 2",
        itemCount: 5,
        totalSize: 4,
      }),
    ];
  });

  const sourceNames = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector(".sources-name-text")?.textContent);

  it("keeps the existing item-count order by default and toggles source-name sorting", () => {
    render(<SourcesManager />);

    expect(sourceNames()).toEqual(["Alpha", "Album 10", "Album 2", "Zeta"]);
    expect(screen.getByRole("columnheader", { name: /Items/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );

    fireEvent.click(screen.getByRole("button", { name: "Sort by Source ascending" }));
    expect(sourceNames()).toEqual(["Album 2", "Album 10", "Alpha", "Zeta"]);
    expect(screen.getByRole("columnheader", { name: /Source/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );

    fireEvent.click(screen.getByRole("button", { name: "Sort by Source descending" }));
    expect(sourceNames()).toEqual(["Zeta", "Alpha", "Album 10", "Album 2"]);
  });

  it("sorts sizes numerically while preserving the active filter", () => {
    render(<SourcesManager />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter sources" }), {
      target: { value: "album" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sort by Size ascending" }));

    expect(sourceNames()).toEqual(["Album 2", "Album 10"]);
    expect(screen.getByRole("columnheader", { name: /Size/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });
});
