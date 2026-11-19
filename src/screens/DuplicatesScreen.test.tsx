import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  cancel: vi.fn(),
  onProgress: vi.fn(async () => () => {}),
}));

vi.mock("../engine/commands/tauri", () => ({
  tauri: {
    items: { revealInFinder: vi.fn() },
    system: { revealInFinder: vi.fn() },
    duplicates: { cancel: fileScanMock.cancel },
    fileDuplicates: { scan: fileScanMock.scan, trash: fileScanMock.trash },
  },
  events: { onFileDuplicatesProgress: fileScanMock.onProgress },
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
    expect(screen.getByRole("heading", { name: "Find duplicate media" })).toBeTruthy();
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

  it("offers an any-file scan for one folder and defaults to the first source", () => {
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

    expect(onChangeScope).toHaveBeenCalledWith("/shoots/rain");
    expect(screen.getByRole("heading", { name: "Duplicate files" })).toBeTruthy();
    // One folder at a time: "All folders" has no meaning for this scan, and the
    // first source stands in so the screen never asks for a folder it already has.
    expect(screen.queryByRole("option", { name: "All folders" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Find duplicate files" })).toBeTruthy();
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

    fireEvent.click(screen.getByLabelText(/Select a\.xmp in \/shoots\/rain\/copy/));
    fireEvent.click(screen.getByRole("button", { name: /Move to Trash/ }));
    // Documents are not photos: one click arms, it does not move.
    expect(fileScanMock.trash).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm: move 1 to Trash" }));
    await waitFor(() => expect(fileScanMock.trash).toHaveBeenCalledWith(["copy"]));
  });
});
