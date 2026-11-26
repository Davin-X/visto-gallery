// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LibraryInspector } from "./LibraryInspector";
import type { MediaItem } from "../../engine/types/media";

vi.mock("../../design/components/CachedThumbnail", () => ({
  CachedThumbnail: () => <div data-testid="cached-thumb" />,
}));

function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "raw-1",
    path: "/photos/sample1.cr2",
    name: "sample1.cr2",
    extension: "cr2",
    kind: "raw",
    size: 64_000_000,
    createdAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    capturedAt: 1_700_000_000_000,
    width: 8688,
    height: 5792,
    favorite: false,
    hidden: false,
    isAnimated: false,
    rating: 0,
    colorLabel: null,
    tags: [],
    albumIds: [],
    ...overrides,
  };
}

describe("LibraryInspector actions", () => {
  it("renders accessible icon-only action buttons and fires their callbacks", () => {
    const onOpenViewer = vi.fn();
    const onToggleFavorite = vi.fn();
    const onToggleHidden = vi.fn();
    const onToggleSelect = vi.fn();

    render(
      <LibraryInspector
        item={makeItem()}
        selectedCount={0}
        isSelected={false}
        draftTransforms={new Map()}
        assetUrl={(p) => p}
        canPlayBackground={false}
        playingId={null}
        isPlaying={false}
        toggleBackground={vi.fn()}
        veiled={false}
        masked={false}
        previewHandlers={{}}
        copiedPathFor={null}
        copyItemPath={vi.fn()}
        actions={{
          onToggleInspector: vi.fn(),
          onOpenViewer,
          onToggleFavorite,
          onToggleHidden,
          onToggleSelect,
          onSetRatingForIds: vi.fn(),
          onSetColorLabelForIds: vi.fn(),
          onUpdateTags: vi.fn(),
        }}
      />,
    );

    for (const label of ["View item", "Add to favorites", "Hide", "Add to selection"]) {
      const btn = screen.getByRole("button", { name: label });
      expect(btn.getAttribute("type")).toBe("button");
      fireEvent.click(btn);
    }

    expect(onOpenViewer).toHaveBeenCalledWith("raw-1");
    expect(onToggleFavorite).toHaveBeenCalledWith("raw-1");
    expect(onToggleHidden).toHaveBeenCalledWith("raw-1");
    expect(onToggleSelect).toHaveBeenCalledWith("raw-1");
  });

  it("renders Play in background button for videos", () => {
    const toggleBackground = vi.fn();
    const video = makeItem({ id: "vid-1", kind: "video", extension: "mp4", name: "clip.mp4" });

    render(
      <LibraryInspector
        item={video}
        selectedCount={0}
        isSelected={false}
        draftTransforms={new Map()}
        assetUrl={(p) => p}
        canPlayBackground
        playingId={null}
        isPlaying={false}
        toggleBackground={toggleBackground}
        veiled={false}
        masked={false}
        previewHandlers={{}}
        copiedPathFor={null}
        copyItemPath={vi.fn()}
        actions={{
          onToggleInspector: vi.fn(),
          onOpenViewer: vi.fn(),
          onToggleFavorite: vi.fn(),
          onToggleHidden: vi.fn(),
          onToggleSelect: vi.fn(),
          onSetRatingForIds: vi.fn(),
          onSetColorLabelForIds: vi.fn(),
          onUpdateTags: vi.fn(),
        }}
      />,
    );

    const playBtn = screen.getByRole("button", { name: "Play in background" });
    expect(playBtn.getAttribute("type")).toBe("button");
    fireEvent.click(playBtn);
    expect(toggleBackground).toHaveBeenCalledWith(video);
  });
});
