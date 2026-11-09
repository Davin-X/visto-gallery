import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DuplicatesScreen from "./DuplicatesScreen";
import type { MediaItem } from "../engine/types/media";
import type { DuplicateGroup } from "../engine/types/media";
import { makeMediaItem } from "../test/fixtures";

vi.mock("../design/components/CachedThumbnail", () => ({
  CachedThumbnail: ({ itemId }: { itemId: string }) => (
    <span className="test-thumb" data-item={itemId} />
  ),
}));

vi.mock("../engine/commands/tauri", () => ({
  tauri: { system: { revealInFinder: vi.fn() } },
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

function renderScreen(groups: DuplicateGroup[]) {
  const onRequestDeleteItems = vi.fn();
  const props = {
    groups,
    items: groups.flatMap((group) => group.items),
    onScan: vi.fn(),
    onClear: vi.fn(),
    busy: false,
    assetUrl: (path: string) => path,
    onRequestDeleteItems,
    onHideIds: vi.fn(),
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
    const jpg = item({ id: "keep" });
    const copy = item({ id: "copy" });
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
});
