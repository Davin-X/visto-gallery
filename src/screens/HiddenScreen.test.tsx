import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "@testing-library/react";
import { useLibraryStore } from "../engine/stores/useLibraryStore";
import type { MediaItem } from "../engine/types/media";

vi.mock("../engine/stores/useLibraryStore", () => ({
  useLibraryStore: vi.fn(),
}));

vi.mock("../screens/LibraryScreen", () => ({
  default: vi.fn(() => null),
}));

import HiddenScreen from "./HiddenScreen";
import LibraryScreenMock from "../screens/LibraryScreen";

const mockedLibraryScreen = vi.mocked(LibraryScreenMock);
const mockedUseLibraryStore = vi.mocked(useLibraryStore);

function makeHiddenItem(
  id: string,
  name: string,
  kind: "photo" | "video" | "raw" = "photo",
  favorite = false,
): MediaItem {
  return {
    id,
    path: `/tmp/${name}`,
    name,
    extension: name.split(".").pop() || "",
    kind,
    size: 100,
    modifiedAt: 1_700_000_000_000,
    favorite,
    hidden: true,
    isAnimated: false,
    tags: [],
    albumIds: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

const defaultStore = () => ({
  albums: [],
  busy: false,
  clearSelection: vi.fn(),
  colorLabelFilter: null,
  dateFrom: null,
  dateTo: null,
  deleteItems: vi.fn(),
  hiddenCount: 2,
  hiddenFilter: "All",
  hiddenItems: [
    makeHiddenItem("h1", "secret1.jpg", "photo", false),
    makeHiddenItem("h2", "secret2.mp4", "video", true),
  ],
  hiddenQuery: "",
  inspectItem: vi.fn(),
  inspectedId: null,
  items: [],
  layout: "grid",
  minRating: null,
  progress: null,
  selectedIds: [],
  setActiveAlbum: vi.fn(),
  setColorLabelFilter: vi.fn(),
  setColorLabelForIds: vi.fn(),
  setDateRange: vi.fn(),
  setFavoriteForIds: vi.fn(),
  setHiddenFilter: vi.fn(),
  setHiddenForIds: vi.fn(),
  setHiddenQuery: vi.fn(),
  setLayout: vi.fn(),
  setMinRating: vi.fn(),
  setRatingForIds: vi.fn(),
  setSelectedIds: vi.fn(),
  showInspector: true,
  showNotice: vi.fn(),
  toggleFavorite: vi.fn(),
  toggleHidden: vi.fn(),
  toggleInspector: vi.fn(),
  toggleSelection: vi.fn(),
  updateItemTags: vi.fn(),
});

function renderHiddenScreen(storeOverrides: Partial<ReturnType<typeof defaultStore>> = {}) {
  const store = { ...defaultStore(), ...storeOverrides };
  mockedUseLibraryStore.mockReturnValue(store);
  return render(
    <HiddenScreen
      assetUrl={() => "/tmp"}
      searchInputRef={React.createRef<HTMLInputElement | null>()}
      onContextMenu={() => {}}
      onNavigate={() => {}}
      onCreateAlbum={() => {}}
      onOpenAlbumPicker={() => {}}
      onRequestDeleteItems={() => {}}
      onOpenEdit={() => {}}
      onOpenViewer={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("HiddenScreen", () => {
  it("passes hiddenItems (not library items) to LibraryScreen", () => {
    renderHiddenScreen();
    expect(mockedLibraryScreen).toHaveBeenCalled();
    const props = mockedLibraryScreen.mock.calls[0][0];
    expect(props.hiddenView).toBe(true);
    expect(props.activeAlbum).toBeNull();
    expect(props.items).toHaveLength(2);
    expect(props.items.map((i: MediaItem) => i.id)).toEqual(["h1", "h2"]);
    // items should be hiddenItems, not library.items
    expect(props.items[0].hidden).toBe(true);
  });

  it("passes libraryStats derived from hidden items", () => {
    renderHiddenScreen();
    const props = mockedLibraryScreen.mock.calls[0][0];
    expect(props.libraryStats).toEqual({
      photos: 1,
      videos: 1,
      raws: 0,
      animations: 0,
      favorites: 1,
    });
    expect(props.hiddenCount).toBe(2);
  });

  it("passes the server-filtered page through untouched when hiddenFilter changes", () => {
    renderHiddenScreen();
    let props = mockedLibraryScreen.mock.calls[0][0];
    expect(props.filter).toBe("All");
    expect(props.items).toHaveLength(2);

    // Filtering happens server-side (get_hidden_items with the hiddenFilter
    // mapped into the page query); the screen renders the page it got.
    renderHiddenScreen({ hiddenFilter: "Photos" });
    props = mockedLibraryScreen.mock.calls[1][0];
    expect(props.filter).toBe("Photos");
    expect(props.items).toHaveLength(2);
  });

  it("allows inspecting a hidden item", () => {
    const inspectItem = vi.fn();
    renderHiddenScreen({ inspectItem });
    // inspectItem is passed to LibraryScreen as onInspectItem
    const props = mockedLibraryScreen.mock.calls[0][0];
    expect(props.onInspectItem).toBe(inspectItem);
  });
});
