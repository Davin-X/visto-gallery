import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DuplicatesScreen from "./DuplicatesScreen";
import type { MediaItem } from "../engine/types/media";
import type { DuplicateGroup } from "../engine/types/media";
import { makeLibraryFolder, makeMediaItem } from "../test/fixtures";

vi.mock("../design/components/CachedThumbnail", () => ({
  CachedThumbnail: ({ itemId }: { itemId: string }) => (
    <span className="test-thumb" data-item={itemId} />
  ),
}));

const fileScanMock = vi.hoisted(() => ({
  scan: vi.fn(),
  trash: vi.fn(),
  chooseFolder: vi.fn(async (): Promise<string | null> => null),
  reveal: vi.fn(async (): Promise<void> => {}),
  cancel: vi.fn(),
  onProgress: vi.fn(async () => () => {}),
}));

vi.mock("../engine/commands/tauri", () => ({
  tauri: {
    items: { revealInFinder: vi.fn() },
    system: { revealInFinder: vi.fn() },
    duplicates: { cancel: fileScanMock.cancel, cancelSimilar: vi.fn() },
    fileDuplicates: {
      chooseFolder: fileScanMock.chooseFolder,
      scan: fileScanMock.scan,
      trash: fileScanMock.trash,
      reveal: fileScanMock.reveal,
    },
  },
  events: {
    onFileDuplicatesProgress: fileScanMock.onProgress,
    onSimilarProgress: vi.fn(async () => () => {}),
  },
}));

function item(overrides: Partial<MediaItem> & { id: string }): MediaItem {
  return makeMediaItem({
    name: `${overrides.id}.jpg`,
    path: `/library/${overrides.id}.jpg`,
    ...overrides,
  });
}

function makeGroup(items: MediaItem[]): DuplicateGroup {
  return { id: `group-${items[0].id}`, sha256: "sha", size: items[0].size, items };
}

function selectedSummary(): string {
  const bar = document.querySelector(".duplicate-selection-copy");
  return (bar?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function renderScreen(
  groups: DuplicateGroup[],
  scanned = true,
  extra: Partial<Parameters<typeof DuplicatesScreen>[0]> = {},
) {
  const onRequestDeleteItems = vi.fn();
  const props = {
    groups,
    scanned,
    items: groups.flatMap((group) => group.items),
    onScan: vi.fn(),
    onClear: vi.fn(),
    busy: false,
    assetUrl: (path: string) => path,
    onRequestDeleteItems,
    onHideIds: vi.fn(),
    ...extra,
  };
  return { ...render(<DuplicatesScreen {...props} />), props, onRequestDeleteItems };
}

describe("DuplicatesScreen", () => {
  it("preserves burst scan results on mount and clears them when the scope changes", () => {
    const groups = [
      {
        id: "burst-1",
        groupType: "burst",
        status: "review",
        reason: "time_and_visual_similarity",
        keeperId: "burst-photo",
        confidence: 0.9,
        items: [item({ id: "burst-photo" })],
      },
    ];
    const onSetBurstGroups = vi.fn();
    const onSetBurstScanned = vi.fn();

    const view = renderScreen([], true, {
      mode: "bursts",
      burstGroups: groups,
      burstScanned: true,
      onSetBurstGroups,
      onSetBurstScanned,
    });

    expect(onSetBurstGroups).not.toHaveBeenCalled();
    expect(onSetBurstScanned).not.toHaveBeenCalled();
    expect(screen.getByText("burst-photo.jpg")).toBeInTheDocument();

    view.rerender(<DuplicatesScreen {...view.props} scope="/another-folder" />);

    expect(onSetBurstGroups).toHaveBeenCalledWith([]);
    expect(onSetBurstScanned).toHaveBeenCalledWith(false);
  });

  it("marks the best-quality copy as the keeper and counts the rest as copies", () => {
    const jpg = item({ id: "keep" });
    const raw = item({ id: "raw", name: "raw.cr2", kind: "raw", extension: "cr2" });

    renderScreen([makeGroup([jpg, raw])]);

    const keeperTile = screen.getByLabelText(/Select raw\.cr2/i).closest("figure");
    expect(keeperTile?.className).toContain("is-keeper");
    expect(selectedSummary()).toContain("0 of 1 extra copies selected");
  });

  it("puts a real thumbnail on every sheet of the fan", () => {
    const items = ["a", "b", "c", "d"].map((id) => item({ id }));

    const { container } = renderScreen([makeGroup(items)]);

    const sheets = container.querySelectorAll(".duplicate-stack-sheet");
    // Keeper on top plus one plate per copy, capped at two plates.
    expect(sheets).toHaveLength(3);
    sheets.forEach((sheet) => {
      expect(sheet.querySelector(".test-thumb, .duplicate-stack-raw")).not.toBeNull();
    });
    expect(container.querySelector(".duplicate-stack-sheet.is-front .test-thumb")).not.toBeNull();
    expect(container.querySelectorAll(".duplicate-stack-sheet.is-back .test-thumb")).toHaveLength(
      2,
    );
  });

  it("opens the compare overlay for a copy and lists the metadata differences", () => {
    // The keeper is the best-quality copy, so it has to be the larger file.
    const keeper = item({ id: "keep", name: "keep.jpg", size: 4_200_000 });
    const copy = item({ id: "copy", name: "copy.jpg", size: 4_000_000 });

    renderScreen([makeGroup([keeper, copy])]);

    fireEvent.click(screen.getByLabelText(/Compare copy\.jpg with the keeper/i));

    const dialog = screen.getByRole("dialog", { name: /Keeper vs copy/i });
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("keep.jpg");
    expect(dialog.textContent).toContain("copy.jpg");
    // Size differs, so the row is flagged and the header counts it.
    expect(dialog.querySelectorAll(".compare-table tr.is-diff").length).toBeGreaterThan(0);
    expect(dialog.textContent).toMatch(/fields? differs?/);

    fireEvent.click(screen.getByRole("button", { name: /Close compare/i }));
    expect(screen.queryByRole("dialog", { name: /Keeper vs copy/i })).toBeNull();
  });

  it("prunes the selection when the selected copy disappears", () => {
    // The larger file wins the keeper slot deterministically; otherwise the
    // name tie-break would crown "copy.jpg" and the assertion below would be
    // testing the keeper, not an extra copy.
    const jpg = item({ id: "keep", size: 4_200_000 });
    const copy = item({ id: "copy", size: 4_000_000 });
    const group = makeGroup([jpg, copy]);

    const { rerender, props, onRequestDeleteItems } = renderScreen([group]);

    fireEvent.click(screen.getByLabelText(/Select copy\.jpg/i));
    expect(selectedSummary()).toContain("1 of 1 extra copies selected");

    // The store drops a trashed copy from the group; the stale id must not
    // keep the action bar alive.
    rerender(<DuplicatesScreen {...props} groups={[makeGroup([jpg])]} items={[jpg]} />);

    expect(selectedSummary()).toContain("0 of 0 extra copies selected");
    const trashButton = screen.getByRole("button", { name: /Move to Trash/i });
    expect((trashButton as HTMLButtonElement).disabled).toBe(true);
    expect(onRequestDeleteItems).not.toHaveBeenCalled();
  });

  it("does not claim there are no duplicates before any scan", () => {
    renderScreen([], false);
    expect(screen.getByRole("heading", { name: "Ready to scan your library" })).toBeTruthy();
    expect(screen.queryByText(/No duplicates found/)).toBeNull();
    expect(screen.queryByText(/unique by content/)).toBeNull();
    // One scan button, in the empty state, not a second one in the header.
    expect(screen.getAllByRole("button", { name: /Scan library|Rescan/ })).toHaveLength(1);
  });

  it("limits the scan to the folder picked in the header", () => {
    const onChangeScope = vi.fn();
    renderScreen([], false, {
      folders: [
        makeLibraryFolder({ path: "/shoots/rain", name: "Rain" }),
        makeLibraryFolder({ path: "/shoots/snow", name: "Snow" }),
      ],
      scope: null,
      onChangeScope,
    });

    const picker = screen.getByLabelText("Only compare files in this folder");
    fireEvent.change(picker, { target: { value: "/shoots/rain" } });
    expect(onChangeScope).toHaveBeenCalledWith("/shoots/rain");
  });

  it("keeps the distinguishing tail visible for long similar folder names", () => {
    const alpha = "my-very-long-backup-photos-folder-2025-archive-alpha";
    const beta = "my-very-long-backup-photos-folder-2025-archive-beta";
    const { container } = renderScreen([], false, {
      folders: [
        makeLibraryFolder({ path: `/archive/${alpha}`, name: alpha }),
        makeLibraryFolder({ path: `/archive/${beta}`, name: beta }),
      ],
      scope: `/archive/${alpha}`,
      onChangeScope: vi.fn(),
    });

    const tail = container.querySelector(".duplicate-folder-value .middle-truncate-tail");
    expect(tail?.textContent).toBe("hive-alpha");
  });

  it("says a scoped scan found nothing in that folder, not the library", () => {
    renderScreen([], true, {
      folders: [makeLibraryFolder({ path: "/shoots/rain", name: "Rain" })],
      scope: "/shoots/rain",
    });

    expect(screen.getByText(/inside Rain is unique by content/)).toBeTruthy();
    expect(screen.queryByText(/in your library is unique by content/)).toBeNull();
    expect(screen.getByRole("button", { name: "Scan again" })).toBeTruthy();
  });

  it("reports no duplicates only after a scan, with a single Scan again button", () => {
    renderScreen([], true);
    expect(screen.getByRole("heading", { name: "No duplicates found" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Scan again|Scan library|Rescan/ })).toHaveLength(
      1,
    );
    expect(screen.getByRole("button", { name: "Scan again" })).toBeTruthy();
  });

  it("offers an any-file scan for one folder without touching the media scope", () => {
    const onChangeScope = vi.fn();
    renderScreen([], false, {
      folders: [
        makeLibraryFolder({ path: "/shoots/rain", name: "Rain" }),
        makeLibraryFolder({ path: "/shoots/snow", name: "Snow" }),
      ],
      scope: null,
      onChangeScope,
    });

    fireEvent.click(screen.getByRole("button", { name: "Any file type" }));

    // Previewing the mode must not narrow the media scan or clear its results.
    expect(onChangeScope).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Duplicate files" })).toBeTruthy();
    // The library-source dropdown still shows "All folders" (the default),
    // and a "Choose folder…" button appears next to it for any-file scans.
    expect(screen.getByRole("option", { name: "All folders" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose folder…" })).toBeTruthy();
    // The library-source dropdown value is empty ("All folders" selected).
    expect(
      (screen.getByLabelText("Only compare files in this folder") as HTMLSelectElement).value,
    ).toBe("");
    expect(screen.getByRole("heading", { name: /^Ready to scan/ })).toBeTruthy();
  });

  it("scans a folder picked outside the library sources", async () => {
    fileScanMock.chooseFolder.mockResolvedValue("/Volumes/archive/scans");
    fileScanMock.scan.mockResolvedValue({
      scope: "/Volumes/archive/scans",
      filesScanned: 2,
      filesCompared: 2,
      bytesHashed: 10,
      stoppedEarly: null,
      cancelled: false,
      groups: [],
    });
    const onChangeScope = vi.fn();

    renderScreen([], false, {
      folders: [makeLibraryFolder({ path: "/shoots/rain", name: "Rain" })],
      scope: "/shoots/rain",
      onChangeScope,
    });

    fireEvent.click(screen.getByRole("button", { name: "Any file type" }));
    // The native picker opens from the "Choose folder…" button.
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));

    // The picked folder appears as a pill with its name ("scans").
    expect(await screen.findByText("scans")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scan folder" }));
    await waitFor(() => expect(fileScanMock.scan).toHaveBeenCalledWith("/Volumes/archive/scans"));
    // Picking a folder for this scan must not narrow the media scan.
    expect(onChangeScope).not.toHaveBeenCalled();
  });

  it("compares every file type and moves only the copies the user confirms", async () => {
    fileScanMock.scan.mockResolvedValue({
      scope: "/shoots/rain",
      filesScanned: 12,
      filesCompared: 2,
      bytesHashed: 4096,
      stoppedEarly: null,
      cancelled: false,
      groups: [
        {
          id: "sha-1",
          size: 2048,
          items: [
            {
              id: "keep",
              path: "/shoots/rain/a.xmp",
              name: "a.xmp",
              extension: "xmp",
              size: 2048,
              keeper: true,
            },
            {
              id: "copy",
              path: "/shoots/rain/copy/a.xmp",
              name: "a.xmp",
              extension: "xmp",
              size: 2048,
              keeper: false,
            },
          ],
        },
      ],
    });
    fileScanMock.trash.mockResolvedValue({ trashed: ["copy"], failed: [] });

    renderScreen([], false, {
      folders: [makeLibraryFolder({ path: "/shoots/rain", name: "Rain" })],
      scope: "/shoots/rain",
      onChangeScope: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Any file type" }));
    fireEvent.click(screen.getByRole("button", { name: "Scan folder" }));

    // Sidecar files have no thumbnail pipeline, so they render as plain rows.
    expect(await screen.findAllByText("a.xmp")).toHaveLength(2);
    expect(fileScanMock.scan).toHaveBeenCalledWith("/shoots/rain");
    expect(screen.getByText("Keep")).toBeTruthy();

    // A sidecar is not a catalog row: revealing it goes by scan id, not path.
    fireEvent.click(screen.getAllByLabelText("Show a.xmp in Finder")[1]);
    expect(fileScanMock.reveal).toHaveBeenCalledWith("copy");

    // The row names its folder relative to the scanned one, not the absolute path.
    fireEvent.click(screen.getByLabelText("Select a.xmp in copy"));
    expect(screen.getByLabelText("Select a.xmp in This folder")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Move to Trash/ }));
    // Documents are not photos: one click arms, it does not move.
    expect(fileScanMock.trash).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm: move 1 to Trash" }));
    await waitFor(() => expect(fileScanMock.trash).toHaveBeenCalledWith(["copy"]));
  });

  it("reloads the library after a file trash so catalogued rows disappear", async () => {
    fileScanMock.scan.mockResolvedValue({
      scope: "/shoots/rain",
      filesScanned: 2,
      filesCompared: 2,
      bytesHashed: 10,
      stoppedEarly: null,
      cancelled: false,
      groups: [
        {
          id: "sha-2",
          size: 5,
          items: [
            {
              id: "keep-2",
              path: "/shoots/rain/b.jpg",
              name: "b.jpg",
              extension: "jpg",
              size: 5,
              keeper: true,
            },
            {
              id: "copy-2",
              path: "/shoots/rain/old/b.jpg",
              name: "b.jpg",
              extension: "jpg",
              size: 5,
              keeper: false,
            },
          ],
        },
      ],
    });
    fileScanMock.trash.mockResolvedValue({ trashed: ["copy-2"], failed: [] });
    const onFilesTrashed = vi.fn();

    renderScreen([], false, {
      folders: [makeLibraryFolder({ path: "/shoots/rain", name: "Rain" })],
      scope: "/shoots/rain",
      onChangeScope: vi.fn(),
      onFilesTrashed,
    });

    fireEvent.click(screen.getByRole("button", { name: "Any file type" }));
    fireEvent.click(screen.getByRole("button", { name: "Scan folder" }));
    expect(await screen.findAllByText("b.jpg")).toHaveLength(2);

    fireEvent.click(screen.getByLabelText("Select b.jpg in old"));
    fireEvent.click(screen.getByRole("button", { name: /Move to Trash/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm: move 1 to Trash" }));

    await waitFor(() => expect(onFilesTrashed).toHaveBeenCalled());
  });

  it("renders file duplicate groups a page at a time", async () => {
    // 51 groups is past one page: the DOM must stop at 50 until it is asked.
    const groups = Array.from({ length: 51 }, (_, index) => ({
      id: `sha-${index}`,
      size: 10,
      items: [
        {
          id: `keep-${index}`,
          path: `/shoots/rain/keep-${index}.txt`,
          name: `keep-${index}.txt`,
          extension: "txt",
          size: 10,
          keeper: true,
        },
        {
          id: `copy-${index}`,
          path: `/shoots/rain/old/keep-${index}.txt`,
          name: `keep-${index}.txt`,
          extension: "txt",
          size: 10,
          keeper: false,
        },
      ],
    }));
    fileScanMock.scan.mockResolvedValue({
      scope: "/shoots/rain",
      filesScanned: 102,
      filesCompared: 102,
      bytesHashed: 1020,
      stoppedEarly: null,
      cancelled: false,
      groups,
    });

    renderScreen([], false, {
      folders: [makeLibraryFolder({ path: "/shoots/rain", name: "Rain" })],
      scope: "/shoots/rain",
      onChangeScope: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Any file type" }));
    fireEvent.click(screen.getByRole("button", { name: "Scan folder" }));

    expect(await screen.findAllByText("2 identical copies")).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Show 1 more group" }));
    expect(screen.getAllByText("2 identical copies")).toHaveLength(51);
    // The last group is in the DOM, so the button is gone.
    expect(screen.queryByRole("button", { name: /more group/ })).toBeNull();
  });

  it("does not call a cancelled scan unique", async () => {
    fileScanMock.scan.mockResolvedValue({
      scope: "/shoots/rain",
      filesScanned: 3,
      filesCompared: 0,
      bytesHashed: 0,
      stoppedEarly: null,
      cancelled: true,
      groups: [],
    });

    renderScreen([], false, {
      folders: [makeLibraryFolder({ path: "/shoots/rain", name: "Rain" })],
      scope: "/shoots/rain",
      onChangeScope: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Any file type" }));
    fireEvent.click(screen.getByRole("button", { name: "Scan folder" }));

    expect(await screen.findByRole("heading", { name: "Scan cancelled" })).toBeTruthy();
    expect(screen.queryByText(/No two files have the same contents/)).toBeNull();
    expect(screen.getByText(/before the scan stopped/)).toBeTruthy();
  });

  it("leaves the first copy unselected when a group has no keeper", async () => {
    fileScanMock.scan.mockResolvedValue({
      scope: "/shoots/rain",
      filesScanned: 2,
      filesCompared: 2,
      bytesHashed: 8,
      stoppedEarly: null,
      cancelled: false,
      groups: [
        {
          id: "sha-4",
          size: 4,
          items: [
            {
              id: "first-4",
              path: "/shoots/rain/d.json",
              name: "d.json",
              extension: "json",
              size: 4,
              keeper: false,
            },
            {
              id: "second-4",
              path: "/shoots/rain/old/d.json",
              name: "d.json",
              extension: "json",
              size: 4,
              keeper: false,
            },
          ],
        },
      ],
    });

    renderScreen([], false, {
      folders: [makeLibraryFolder({ path: "/shoots/rain", name: "Rain" })],
      scope: "/shoots/rain",
      onChangeScope: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Any file type" }));
    fireEvent.click(screen.getByRole("button", { name: "Scan folder" }));
    await screen.findAllByText("d.json");

    // The selection bar renders before the groups, so its button comes first.
    fireEvent.click(screen.getAllByRole("button", { name: "Select copies" })[0]);

    const first = screen.getByLabelText("Select d.json in This folder");
    const second = screen.getByLabelText("Deselect d.json in old");
    expect(first.getAttribute("aria-pressed")).toBe("false");
    expect(second.getAttribute("aria-pressed")).toBe("true");
    // The header counts what the button would actually move.
    expect(screen.getByText(/1 extra copy/)).toBeTruthy();
  });

  it("drops a scan that finishes after the folder changed", async () => {
    const staleScan = {
      scope: "/shoots/rain",
      filesScanned: 2,
      filesCompared: 2,
      bytesHashed: 10,
      stoppedEarly: null,
      cancelled: false,
      groups: [
        {
          id: "sha-3",
          size: 4,
          items: [
            {
              id: "keep-3",
              path: "/shoots/rain/c.xmp",
              name: "c.xmp",
              extension: "xmp",
              size: 4,
              keeper: true,
            },
            {
              id: "copy-3",
              path: "/shoots/rain/old/c.xmp",
              name: "c.xmp",
              extension: "xmp",
              size: 4,
              keeper: false,
            },
          ],
        },
      ],
    };
    let resolveScan: (value: typeof staleScan) => void = () => {};
    fileScanMock.scan.mockReturnValueOnce(
      new Promise<typeof staleScan>((resolve) => {
        resolveScan = resolve;
      }),
    );

    const { props, rerender } = renderScreen([], false, {
      folders: [
        makeLibraryFolder({ path: "/shoots/rain", name: "Rain" }),
        makeLibraryFolder({ path: "/shoots/snow", name: "Snow" }),
      ],
      scope: "/shoots/rain",
      onChangeScope: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Any file type" }));
    fireEvent.click(screen.getByRole("button", { name: "Scan folder" }));
    // The picker cannot be changed mid-scan; a store-driven change still must
    // not paint the old folder's results under the new one.
    expect(
      (screen.getByLabelText("Only compare files in this folder") as HTMLSelectElement).disabled,
    ).toBe(true);

    rerender(<DuplicatesScreen {...props} scope="/shoots/snow" />);
    await act(async () => {
      resolveScan(staleScan);
    });

    expect(screen.queryByText("c.xmp")).toBeNull();
    expect(screen.getByRole("heading", { name: /^Ready to scan/ })).toBeTruthy();
  });
});
