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
    openDialog: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.openDialog }));
vi.mock("../../engine/commands/tauri", () => ({
  formatBytes: (bytes: number) => `${bytes} B`,
  tauri: {
    items: { revealInFinder: vi.fn(async () => {}) },
    rootMap: { preview: mocks.preview, apply: mocks.apply },
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
    mocks.openDialog.mockResolvedValue("/Volumes/New/Photos");
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
    mocks.openDialog.mockResolvedValue("/Volumes/New/Photos");
    mocks.preview.mockResolvedValue({ conflictingPaths: ["/Volumes/New/Photos/a.jpg"] });
    render(<SourcesManager />);

    fireEvent.click(screen.getByRole("button", { name: "Locate…" }));

    await waitFor(() => expect(mocks.state.showNotice).toHaveBeenCalled());
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
