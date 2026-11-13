/// <reference types="vitest/globals" />
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ listen: vi.fn() })),
}));

vi.mock("../commands/tauri", () => ({
  tauri: {
    items: {
      toggleFavorite: vi.fn().mockResolvedValue(undefined),
      moveToTrash: vi.fn().mockResolvedValue({ trashed: [], failed: [] }),
      cancelMoveToTrash: vi.fn().mockResolvedValue(undefined),
    },
    albums: {
      create: vi.fn().mockResolvedValue({ id: "album-1", name: "Trip", itemCount: 0 }),
      delete: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      reorder: vi.fn().mockResolvedValue(undefined),
      addItems: vi.fn().mockResolvedValue(undefined),
      removeItems: vi.fn().mockResolvedValue(undefined),
      getOverviews: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue([]),
      getTags: vi.fn().mockResolvedValue([]),
      getItems: vi.fn().mockResolvedValue([]),
    },
    library: {
      getItems: vi.fn().mockResolvedValue({
        items: [],
        hasMore: false,
        totalCount: 0,
      }),
      getHiddenItems: vi.fn().mockResolvedValue({
        items: [],
        hasMore: false,
        totalCount: 0,
      }),
      getMatchingIds: vi.fn().mockResolvedValue([]),
      getFolders: vi.fn().mockResolvedValue([]),
      getRoots: vi.fn().mockResolvedValue([]),
      cancelScan: vi.fn().mockResolvedValue(undefined),
    },
    duplicates: {
      scan: vi.fn().mockResolvedValue([]),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
    smartAlbums: {
      get: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        id: "smart-1",
        name: "Spring",
        filter: {},
        itemCount: 0,
        createdAt: 1,
        updatedAt: 1,
      }),
      rename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      getItems: vi.fn().mockResolvedValue({
        items: [],
        hasMore: false,
        totalCount: 0,
      }),
    },
  },
  formatBytes: (n: number) => `${n} B`,
}));

import { useLibraryStore } from "../../engine/stores/useLibraryStore";
import { tauri } from "../commands/tauri";
import type { MediaItem } from "../../engine/types/media";

function makeItem(
  id: string,
  name: string,
  favorite = false,
  kind: "photo" | "video" | "raw" = "photo",
): MediaItem {
  // Fixed timestamp keeps sort order deterministic across runs; Date.now()
  // resolution differs per call and made the default (desc by capturedAt)
  // ordering flaky.
  const now = 1_700_000_000_000;
  return {
    id,
    path: `/tmp/${name}`,
    name,
    extension: name.split(".").pop() || "",
    kind,
    size: 100,
    modifiedAt: now,
    favorite,
    hidden: false,
    isAnimated: false,
    tags: [],
    albumIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useLibraryStore.setState(useLibraryStore.getInitialState());
});

test("setFilter narrows visible items", () => {
  const a = makeItem("a", "photo.jpg");
  const b = makeItem("b", "clip.mp4", false, "video");
  useLibraryStore.setState({ items: [a, b] });
  useLibraryStore.getState().refreshDerived();
  expect(useLibraryStore.getState().visibleItems.map((i) => i.id)).toEqual(["a", "b"]);

  useLibraryStore.getState().setFilter("Videos");
  expect(useLibraryStore.getState().visibleItems.map((i) => i.id)).toEqual(["b"]);
});

test("setQuery narrows visible items", () => {
  const a = makeItem("a", "sunset.jpg");
  const b = makeItem("b", "mountain.jpg");
  useLibraryStore.setState({ items: [a, b] });
  useLibraryStore.getState().refreshDerived();

  useLibraryStore.getState().setQuery("sunset");
  expect(useLibraryStore.getState().visibleItems.map((i) => i.id)).toEqual(["a"]);
});

test("loadItemsPage records the view key so scroll restoration waits for fresh rows", async () => {
  vi.mocked(tauri.library.getItems).mockResolvedValue({
    items: [],
    hasMore: false,
    totalCount: 0,
  });

  await useLibraryStore.getState().loadItemsPage();
  const allPhotosKey = useLibraryStore.getState().loadedViewKey;
  expect(allPhotosKey).toBeTruthy();

  useLibraryStore.setState({ filter: "Videos" });
  await useLibraryStore.getState().loadItemsPage();
  expect(useLibraryStore.getState().loadedViewKey).not.toBe(allPhotosKey);

  useLibraryStore.setState({ filter: "All" });
  await useLibraryStore.getState().loadItemsPage();
  expect(useLibraryStore.getState().loadedViewKey).toBe(allPhotosKey);
});

test("viewer filmstrip follows media category and the active browsing scope", () => {
  const photo = makeItem("photo", "photo.jpg");
  const video = makeItem("video", "clip.mp4", false, "video");
  const raw = makeItem("raw", "capture.cr3", false, "raw");
  const albumPhoto = {
    ...makeItem("album-photo", "trip-photo.jpg"),
    albumIds: ["album-1"],
  };
  useLibraryStore.setState({
    items: [photo, video, raw, albumPhoto],
    inspectedId: photo.id,
  });
  useLibraryStore.getState().refreshDerived();
  // Items pass through in the order the backend paginates them (sort column
  // whitelisted server-side, `id` tie-break). The fixture feeds them in
  // backend order — the store no longer re-sorts.
  expect(useLibraryStore.getState().viewerItems.map((item) => item.id)).toEqual([
    "photo",
    "video",
    "raw",
    "album-photo",
  ]);

  useLibraryStore.setState({ filter: "Videos" });
  useLibraryStore.getState().refreshDerived();
  expect(useLibraryStore.getState().viewerItems.map((item) => item.id)).toEqual(["video"]);

  useLibraryStore.setState({
    filter: "All",
    activeAlbum: "album-1",
    query: "trip",
  });
  useLibraryStore.getState().refreshDerived();
  expect(useLibraryStore.getState().viewerItems.map((item) => item.id)).toEqual(["album-photo"]);
});

test("photo viewer navigation loads more pages and skips videos before wrapping", async () => {
  const firstPhoto = {
    ...makeItem("first-photo", "first.jpg"),
    modifiedAt: 1_700_000_000_000,
  };
  const queuedVideo = {
    ...makeItem("queued-video", "clip.mp4", false, "video"),
    modifiedAt: 1_600_000_000_000,
  };
  const nextPhoto = {
    ...makeItem("next-photo", "next.jpg"),
    modifiedAt: 1_500_000_000_000,
  };
  useLibraryStore.setState({
    items: [firstPhoto],
    inspectedId: firstPhoto.id,
    hasMore: true,
    nextCursor: "page-2",
    pageSize: 2,
  });
  useLibraryStore.getState().refreshDerived();
  vi.mocked(tauri.library.getItems)
    .mockResolvedValueOnce({
      items: [queuedVideo],
      hasMore: true,
      nextCursor: "page-3",
      totalCount: 3,
    })
    .mockResolvedValueOnce({
      items: [nextPhoto],
      hasMore: false,
      totalCount: 3,
    });

  const navigated = await useLibraryStore.getState().navigateViewerPhoto(1);

  expect(navigated).toBe(true);
  expect(useLibraryStore.getState().viewerSelected?.id).toBe("next-photo");
  expect(tauri.library.getItems).toHaveBeenCalledTimes(2);
});

test("setQuery searches camera and lens metadata", () => {
  const a = { ...makeItem("a", "sunset.jpg"), camera: "Nikon Z8" };
  const b = { ...makeItem("b", "mountain.jpg"), lens: "Nikkor 24-70mm" };
  useLibraryStore.setState({ items: [a, b] });
  useLibraryStore.getState().refreshDerived();

  useLibraryStore.getState().setQuery("Nikkor");
  expect(useLibraryStore.getState().visibleItems.map((i) => i.id)).toEqual(["b"]);
});

test("toggleFavorite updates item and derived state", async () => {
  const a = makeItem("a", "photo.jpg", false);
  useLibraryStore.setState({ items: [a] });
  useLibraryStore.getState().refreshDerived();

  await useLibraryStore.getState().toggleFavorite("a");
  expect(useLibraryStore.getState().items[0].favorite).toBe(true);
});
test("createAlbum adds album and links selected items", async () => {
  const a = makeItem("a", "photo.jpg");
  useLibraryStore.setState({ items: [a], selectedIds: ["a"] });
  useLibraryStore.getState().refreshDerived();

  await useLibraryStore.getState().createAlbum("Trip");
  const state = useLibraryStore.getState();
  expect(state.albums).toHaveLength(1);
  expect(state.albums[0].id).toBe("album-1");
  expect(state.items[0].albumIds).toContain("album-1");
  expect(state.activeAlbum).toBe("album-1");
});

test("deleteAlbum removes album but keeps items", async () => {
  const a = makeItem("a", "photo.jpg");
  a.albumIds = ["album-1"];
  useLibraryStore.setState({
    items: [a],
    albums: [{ id: "album-1", name: "Trip", itemCount: 1 } as any],
    activeAlbum: "album-1",
  });
  useLibraryStore.getState().refreshDerived();

  await useLibraryStore.getState().deleteAlbum("album-1");
  const state = useLibraryStore.getState();
  expect(state.albums).toHaveLength(0);
  expect(state.items[0].albumIds).not.toContain("album-1");
  expect(state.activeAlbum).toBeNull();
});

test("renameAlbum updates album name and its updated date", async () => {
  useLibraryStore.setState({
    albums: [{ id: "album-1", name: "Trip", itemCount: 0, updatedAt: 1 } as any],
  });
  await useLibraryStore.getState().renameAlbum("album-1", "Vacation");
  expect(useLibraryStore.getState().albums[0].name).toBe("Vacation");
  expect(useLibraryStore.getState().albums[0].updatedAt).toBeGreaterThan(1);
});

test("addToAlbum stamps the updated date on both derived lists", async () => {
  useLibraryStore.setState({
    items: [makeItem("a", "photo.jpg")],
    albums: [{ id: "album-1", name: "Trip", itemCount: 0, updatedAt: 1 } as any],
    albumOverviews: [{ id: "album-1", name: "Trip", itemCount: 0, updatedAt: 1 } as any],
  });

  await useLibraryStore.getState().addToAlbum("album-1", ["a"]);

  const state = useLibraryStore.getState();
  expect(state.albums[0].updatedAt).toBeGreaterThan(1);
  expect(state.albumOverviews[0].updatedAt).toBeGreaterThan(1);
});

test("addToAlbum leaves the updated date alone when every item is already a member", async () => {
  const a = makeItem("a", "photo.jpg");
  a.albumIds = ["album-1"];
  useLibraryStore.setState({
    items: [a],
    albums: [{ id: "album-1", name: "Trip", itemCount: 1, updatedAt: 1 } as any],
    albumOverviews: [{ id: "album-1", name: "Trip", itemCount: 1, updatedAt: 1 } as any],
  });

  await useLibraryStore.getState().addToAlbum("album-1", ["a"]);

  const state = useLibraryStore.getState();
  expect(state.albums[0].updatedAt).toBe(1);
  expect(state.albumOverviews[0].updatedAt).toBe(1);
});

test("removeFromAlbum stamps the updated date on both derived lists", async () => {
  const a = makeItem("a", "photo.jpg");
  a.albumIds = ["album-1"];
  useLibraryStore.setState({
    items: [a],
    albums: [{ id: "album-1", name: "Trip", itemCount: 1, updatedAt: 1 } as any],
    albumOverviews: [{ id: "album-1", name: "Trip", itemCount: 1, updatedAt: 1 } as any],
  });

  await useLibraryStore.getState().removeFromAlbum("album-1", ["a"]);

  const state = useLibraryStore.getState();
  expect(state.albums[0].updatedAt).toBeGreaterThan(1);
  expect(state.albumOverviews[0].updatedAt).toBeGreaterThan(1);
});

test("removeFromAlbum stamps the updated date when only hidden members are removed", async () => {
  const a = makeItem("a", "photo.jpg");
  a.albumIds = ["album-1"];
  a.hidden = true;
  useLibraryStore.setState({
    items: [a],
    albums: [{ id: "album-1", name: "Trip", itemCount: 0, updatedAt: 1 } as any],
    albumOverviews: [{ id: "album-1", name: "Trip", itemCount: 0, updatedAt: 1 } as any],
  });

  await useLibraryStore.getState().removeFromAlbum("album-1", ["a"]);

  const state = useLibraryStore.getState();
  expect(state.albums[0].itemCount).toBe(0);
  expect(state.albums[0].updatedAt).toBeGreaterThan(1);
  expect(state.albumOverviews[0].updatedAt).toBeGreaterThan(1);
});

test("removeFromAlbum leaves the updated date alone when nothing was a member", async () => {
  useLibraryStore.setState({
    items: [makeItem("a", "photo.jpg")],
    albums: [{ id: "album-1", name: "Trip", itemCount: 0, updatedAt: 1 } as any],
    albumOverviews: [{ id: "album-1", name: "Trip", itemCount: 0, updatedAt: 1 } as any],
  });

  await useLibraryStore.getState().removeFromAlbum("album-1", ["a"]);

  const state = useLibraryStore.getState();
  expect(state.albums[0].updatedAt).toBe(1);
  expect(state.albumOverviews[0].updatedAt).toBe(1);
});

test("loadLibrary applies date filters to the backend query and uses album overviews", async () => {
  vi.mocked(tauri.albums.getOverviews).mockResolvedValueOnce([
    {
      id: "album-1",
      name: "Trip",
      colorIndex: 0,
      createdAt: 1,
      updatedAt: 1,
      itemCount: 2,
      coverItems: [],
      itemSize: 0,
    },
  ]);
  useLibraryStore.setState({
    dateFrom: 100,
    dateTo: 200,
    query: "trip",
    sortBy: "modifiedAt",
    sortOrder: "asc",
  });
  (window as any).__TAURI_INTERNALS__ = {};

  await useLibraryStore.getState().loadLibrary();
  delete (window as any).__TAURI_INTERNALS__;

  expect(tauri.library.getItems).toHaveBeenCalledWith(
    expect.objectContaining({
      dateFrom: 100,
      dateTo: 200,
      query: "trip",
      sortBy: "modifiedAt",
      sortOrder: "asc",
      limit: 250,
    }),
  );
  expect(tauri.albums.getOverviews).toHaveBeenCalledTimes(1);
  expect(tauri.albums.get).not.toHaveBeenCalled();
  expect(useLibraryStore.getState().albumOverviews).toHaveLength(1);
  expect(useLibraryStore.getState().albumOverviews[0].itemCount).toBe(2);
});

test("createSmartAlbum persists the current whitelisted filter", async () => {
  useLibraryStore.setState({
    filter: "Videos",
    query: "mountain",
    minRating: 3,
    colorLabelFilter: "blue",
    dateFrom: 100,
    dateTo: 200,
  });

  await useLibraryStore.getState().createSmartAlbum("Mountains");

  expect(tauri.smartAlbums.create).toHaveBeenCalledWith(
    "Mountains",
    expect.objectContaining({
      kind: "video",
      query: "mountain",
      rating: 3,
      colorLabel: "blue",
      dateFrom: 100,
      dateTo: 200,
    }),
  );
  expect(useLibraryStore.getState().smartAlbums[0].id).toBe("smart-1");
});

test("openSmartAlbum applies the saved filter definition without arbitrary SQL", async () => {
  useLibraryStore.setState({
    smartAlbums: [
      {
        id: "smart-1",
        name: "Blue mountains",
        filter: {
          kind: "photo",
          query: "mountain",
          rating: 4,
          colorLabel: "blue",
          dateFrom: 100,
          dateTo: 200,
          sourcePath: "/Photos",
        },
        itemCount: 1,
        coverItems: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });

  await useLibraryStore.getState().openSmartAlbum("smart-1");

  const state = useLibraryStore.getState();
  expect(state.activeSmartAlbum).toBe("smart-1");
  expect(state.filter).toBe("Photos");
  expect(state.query).toBe("mountain");
  expect(state.minRating).toBe(4);
  expect(state.colorLabelFilter).toBe("blue");
  expect(state.dateFrom).toBe(100);
  expect(state.dateTo).toBe(200);
  expect(state.activeSource).toBe("/Photos");
  expect(state.activeAlbum).toBeNull();
});

test("clearFilters resets every refinement and reloads the library", async () => {
  (window as any).__TAURI_INTERNALS__ = {};
  useLibraryStore.setState({
    filter: "Videos",
    query: "mountain",
    activeSource: "/Photos",
    activeSmartAlbum: "smart-1",
    minRating: 4,
    colorLabelFilter: "blue",
    cameraFilter: "Nikon Z8",
    lensFilter: "Nikkor",
    dateFrom: 100,
    dateTo: 200,
  });

  useLibraryStore.getState().clearFilters();
  await Promise.resolve();
  delete (window as any).__TAURI_INTERNALS__;

  const state = useLibraryStore.getState();
  expect(state.filter).toBe("All");
  expect(state.query).toBe("");
  expect(state.activeSource).toBeNull();
  expect(state.activeSmartAlbum).toBeNull();
  expect(state.minRating).toBeNull();
  expect(state.colorLabelFilter).toBeNull();
  expect(state.cameraFilter).toBeNull();
  expect(state.lensFilter).toBeNull();
  expect(state.dateFrom).toBeNull();
  expect(state.dateTo).toBeNull();
});

test("clearHiddenFilters resets only hidden-view refinements", () => {
  useLibraryStore.setState({ hiddenFilter: "Videos", hiddenQuery: "clip" });

  useLibraryStore.getState().clearHiddenFilters();

  const state = useLibraryStore.getState();
  expect(state.hiddenFilter).toBe("All");
  expect(state.hiddenQuery).toBe("");
});

test("loadLibrary is non-blocking and shows a quiet refresh state instead", async () => {
  let refreshingDuringCall = false;
  let busyDuringCall = true;
  let progressDuringCall = "unexpected";
  vi.mocked(tauri.library.getItems).mockImplementationOnce(async () => {
    const state = useLibraryStore.getState();
    refreshingDuringCall = state.refreshingLibrary;
    busyDuringCall = state.busy;
    progressDuringCall = state.progress?.phase ?? "none";
    return { items: [], hasMore: false, totalCount: 0 };
  });
  (window as any).__TAURI_INTERNALS__ = {};

  await useLibraryStore.getState().loadLibrary();
  delete (window as any).__TAURI_INTERNALS__;

  expect(refreshingDuringCall).toBe(true);
  expect(busyDuringCall).toBe(false);
  expect(progressDuringCall).toBe("none");
  expect(useLibraryStore.getState().refreshingLibrary).toBe(false);
  expect(useLibraryStore.getState().busy).toBe(false);
  expect(useLibraryStore.getState().progress).toBeNull();
});

test("cancelScan routes the duplicate-hash phase to cancel_find_duplicates", async () => {
  useLibraryStore.setState({ progress: { phase: "hashing", processed: 10, total: 100 } });
  await useLibraryStore.getState().cancelScan();
  expect(tauri.duplicates.cancel).toHaveBeenCalledOnce();
  expect(tauri.library.cancelScan).not.toHaveBeenCalled();
});

test("cancelScan routes the library-scan phase to the library cancel command", async () => {
  useLibraryStore.setState({ progress: { phase: "scanning", processed: 10, total: 100 } });
  await useLibraryStore.getState().cancelScan();
  expect(tauri.library.cancelScan).toHaveBeenCalledOnce();
  expect(tauri.duplicates.cancel).not.toHaveBeenCalled();
});

test("inspectItem accepts hidden item IDs", () => {
  const visible = makeItem("visible", "photo.jpg");
  const hidden = makeItem("hidden", "secret.jpg", false, "photo");
  hidden.hidden = true;
  useLibraryStore.setState({ items: [visible], hiddenItems: [hidden] });

  // Hidden ID is accepted
  useLibraryStore.getState().inspectItem(hidden.id);
  expect(useLibraryStore.getState().inspectedId).toBe(hidden.id);

  // Visible ID still works
  useLibraryStore.getState().inspectItem(visible.id);
  expect(useLibraryStore.getState().inspectedId).toBe(visible.id);

  // Unknown ID is ignored
  useLibraryStore.getState().inspectItem("unknown");
  expect(useLibraryStore.getState().inspectedId).toBe(visible.id);

  // null clears
  useLibraryStore.getState().inspectItem(null);
  expect(useLibraryStore.getState().inspectedId).toBeNull();
});

test("hiddenItems and hiddenCount are derived from hidden items", () => {
  const hidden = makeItem("hidden", "secret.jpg", false, "photo");
  hidden.hidden = true;
  useLibraryStore.setState({ hiddenItems: [hidden] });
  useLibraryStore.getState().refreshDerived();

  const state = useLibraryStore.getState();
  expect(state.hiddenItems).toHaveLength(1);
  expect(state.hiddenCount).toBe(1);
  expect(state.hiddenItems[0].id).toBe("hidden");
});

test("deleteItems sends hidden ids and clears the hidden collection", async () => {
  const visible = makeItem("visible", "visible.jpg");
  const hidden = makeItem("hidden-copy", "hidden-copy.jpg");
  hidden.hidden = true;
  useLibraryStore.setState({
    items: [visible],
    hiddenItems: [hidden],
    hiddenCount: 1,
  });
  vi.mocked(tauri.items.moveToTrash).mockResolvedValueOnce({
    trashed: [hidden.id],
    failed: [],
  });

  const result = await useLibraryStore.getState().deleteItems([hidden.id]);

  expect(tauri.items.moveToTrash).toHaveBeenCalledWith([hidden.id]);
  expect(result).toEqual({ status: "done", trashed: 1, failed: 0, bytes: 100, failures: [] });
  expect(useLibraryStore.getState().hiddenItems).toEqual([]);
  expect(useLibraryStore.getState().hiddenCount).toBe(0);
  expect(useLibraryStore.getState().items).toEqual([visible]);
});

test("deleteItems reports the bytes reclaimed, including rows outside the loaded page", async () => {
  const onPage = makeItem("on-page", "on-page.jpg");
  const offPage = makeItem("off-page", "off-page.jpg");
  offPage.size = 2_000;
  useLibraryStore.setState({
    items: [onPage],
    duplicates: [{ id: "g1", sha256: "abc", size: 2_000, items: [offPage, onPage] }],
  });
  vi.mocked(tauri.items.moveToTrash).mockResolvedValueOnce({
    trashed: [onPage.id, offPage.id],
    failed: [],
  });

  const result = await useLibraryStore.getState().deleteItems([onPage.id, offPage.id]);

  expect(result).toMatchObject({ status: "done", trashed: 2, bytes: 2_100 });
});

test("deleting a hidden item does not shrink the library total", async () => {
  const hidden = makeItem("hidden-copy", "hidden-copy.jpg");
  hidden.hidden = true;
  useLibraryStore.setState({
    items: [],
    hiddenItems: [hidden],
    hiddenCount: 1,
    totalCount: 12,
  });
  vi.mocked(tauri.items.moveToTrash).mockResolvedValueOnce({
    trashed: [hidden.id],
    failed: [],
  });

  await useLibraryStore.getState().deleteItems([hidden.id]);

  // Hidden rows were never counted in totalCount.
  expect(useLibraryStore.getState().totalCount).toBe(12);
});

test("deleting a visible item shrinks the library total by one", async () => {
  const visible = makeItem("visible", "visible.jpg");
  useLibraryStore.setState({ items: [visible], hiddenItems: [], totalCount: 12 });
  vi.mocked(tauri.items.moveToTrash).mockResolvedValueOnce({
    trashed: [visible.id],
    failed: [],
  });

  await useLibraryStore.getState().deleteItems([visible.id]);

  expect(useLibraryStore.getState().totalCount).toBe(11);
});

test("deleteItems works for a duplicate outside the loaded library page", async () => {
  const copy = makeItem("copy", "copy.jpg");
  const keeper = makeItem("keeper", "keeper.jpg");
  useLibraryStore.setState({
    items: [],
    hiddenItems: [],
    duplicates: [{ id: "group-1", sha256: "abc", size: copy.size, items: [keeper, copy] }],
  });
  vi.mocked(tauri.items.moveToTrash).mockResolvedValueOnce({
    trashed: [copy.id],
    failed: [],
  });

  const result = await useLibraryStore.getState().deleteItems([copy.id]);

  // The renderer only sends ids; the backend resolves the path, so the copy
  // does not have to be present in paginated `items`.
  expect(tauri.items.moveToTrash).toHaveBeenCalledWith([copy.id]);
  expect(result).toMatchObject({ status: "done", trashed: 1 });
  expect(useLibraryStore.getState().duplicates).toEqual([]);
});

test("deleteItems deduplicates ids before calling the backend", async () => {
  const hidden = makeItem("hidden-copy", "hidden-copy.jpg");
  hidden.hidden = true;
  useLibraryStore.setState({ hiddenItems: [hidden], hiddenCount: 1 });
  vi.mocked(tauri.items.moveToTrash).mockResolvedValueOnce({
    trashed: [hidden.id],
    failed: [],
  });

  await useLibraryStore.getState().deleteItems([hidden.id, hidden.id]);

  expect(tauri.items.moveToTrash).toHaveBeenCalledWith([hidden.id]);
});

test("deleteItems reports an id that the backend refused instead of claiming success", async () => {
  const hidden = makeItem("hidden-copy", "hidden-copy.jpg");
  hidden.hidden = true;
  useLibraryStore.setState({ hiddenItems: [hidden], hiddenCount: 1 });
  vi.mocked(tauri.items.moveToTrash).mockResolvedValueOnce({
    trashed: [],
    failed: [{ id: hidden.id, code: "notFound", error: "File no longer exists on disk." }],
  });

  const result = await useLibraryStore.getState().deleteItems([hidden.id]);

  expect(result.status).toBe("failed");
  expect(result).toMatchObject({
    failures: [{ error: expect.stringContaining("no longer exists") }],
  });
  // A refused file must not be dropped from the catalog view.
  expect(useLibraryStore.getState().hiddenItems).toEqual([hidden]);
});

test("a fully cancelled delete reports cancellation, not failure", async () => {
  const visible = makeItem("visible", "visible.jpg");
  useLibraryStore.setState({ items: [visible] });
  vi.mocked(tauri.items.moveToTrash).mockResolvedValueOnce({
    trashed: [],
    failed: [{ id: visible.id, code: "cancelled", error: "Operation cancelled" }],
  });

  const result = await useLibraryStore.getState().deleteItems([visible.id]);

  expect(result).toEqual({ status: "cancelled", trashed: 0, failed: 1 });
});

test("a partial cancel keeps the moved items and reports the rest", async () => {
  const a = makeItem("a", "a.jpg");
  const b = makeItem("b", "b.jpg");
  useLibraryStore.setState({ items: [a, b], totalCount: 2 });
  vi.mocked(tauri.items.moveToTrash).mockResolvedValueOnce({
    trashed: [a.id],
    failed: [{ id: b.id, code: "cancelled", error: "Operation cancelled" }],
  });

  const result = await useLibraryStore.getState().deleteItems([a.id, b.id]);

  expect(result).toMatchObject({ status: "done", trashed: 1, failed: 1 });
  expect(useLibraryStore.getState().items).toEqual([b]);
});

test("a catalog warning is surfaced without turning the delete into a failure", async () => {
  const visible = makeItem("visible", "visible.jpg");
  useLibraryStore.setState({ items: [visible], totalCount: 1 });
  vi.mocked(tauri.items.moveToTrash).mockResolvedValueOnce({
    trashed: [visible.id],
    failed: [],
    catalogError: "could not commit the catalog update: disk I/O error",
  });

  const result = await useLibraryStore.getState().deleteItems([visible.id]);

  expect(result.status).toBe("done");
  expect(result).toMatchObject({
    status: "done",
    catalogWarning: expect.stringContaining("catalog"),
  });
});

test("cancelDelete keeps the stable operation overlay in its cancelling state", async () => {
  await useLibraryStore.getState().cancelDelete();

  expect(tauri.items.cancelMoveToTrash).toHaveBeenCalledOnce();
  // deleteItems clears this only after the native command returns its final
  // result, so the user sees a truthful Cancelling… state between batches.
  expect(useLibraryStore.getState().canceling).toBe(true);
});

test("Animations filter narrows to animated items; Photos is still images only", () => {
  const gif = { ...makeItem("gif", "loop.gif"), isAnimated: true };
  const still = makeItem("still", "still.jpg");
  const animatedVideo = {
    ...makeItem("clip", "clip.mp4", false, "video"),
    isAnimated: true,
  };
  useLibraryStore.setState({ items: [gif, still, animatedVideo], filter: "All" });
  useLibraryStore.getState().refreshDerived();
  expect(
    useLibraryStore
      .getState()
      .visibleItems.map((i) => i.id)
      .sort(),
  ).toEqual(["clip", "gif", "still"]);

  useLibraryStore.setState({ filter: "Animations" });
  useLibraryStore.getState().refreshDerived();
  expect(
    useLibraryStore
      .getState()
      .visibleItems.map((i) => i.id)
      .sort(),
  ).toEqual(["clip", "gif"]);

  // Photos excludes animated items; animated files keep their own filter.
  useLibraryStore.setState({ filter: "Photos" });
  useLibraryStore.getState().refreshDerived();
  expect(
    useLibraryStore
      .getState()
      .visibleItems.map((i) => i.id)
      .sort(),
  ).toEqual(["still"]);
});

test("Animations filter is sent to the backend as an animated flag, not a kind", () => {
  useLibraryStore.setState({ filter: "Animations" });
  expect(useLibraryStore.getState().getCurrentLibraryFilter()).toMatchObject({
    animated: true,
    kind: undefined,
  });
});

test("one failing catalog list does not blank the others", async () => {
  vi.mocked(tauri.albums.getOverviews).mockResolvedValueOnce([
    {
      id: "album-1",
      name: "Trip",
      colorIndex: 0,
      itemCount: 3,
      coverItems: [],
      itemSize: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ] as never);
  vi.mocked(tauri.albums.getTags).mockResolvedValueOnce([
    { id: "tag-1", name: "travel", colorIndex: 0, itemCount: 1, createdAt: 1 },
  ] as never);
  vi.mocked(tauri.smartAlbums.get).mockRejectedValueOnce(new Error("near ?: syntax error"));

  await useLibraryStore.getState().loadCatalogMetadata();

  const state = useLibraryStore.getState();
  expect(state.albums.map((album) => album.name)).toEqual(["Trip"]);
  expect(state.tags.map((tag) => tag.name)).toEqual(["travel"]);
  expect(state.notice).toMatch(/Smart Albums/);
  expect(state.notice).not.toMatch(/albums, |tags|sources/);
});

test("loadNextPage keeps the first-page totalCount when continuation pages carry none", async () => {
  const a = makeItem("a", "a.jpg");
  const b = makeItem("b", "b.jpg");
  useLibraryStore.setState({
    items: [a],
    totalCount: 10,
    hasMore: true,
    nextCursor: "page-2",
    page: 0,
    loadingNextPage: false,
    // The stored row came from the first page; the continuation is expected
    // to return null so this stays 10, not 0.
  });
  vi.mocked(tauri.library.getItems).mockResolvedValueOnce({
    items: [b],
    hasMore: true,
    nextCursor: "page-3",
    totalCount: null,
  });

  await useLibraryStore.getState().loadNextPage();

  expect(useLibraryStore.getState().totalCount).toBe(10);
  expect(useLibraryStore.getState().page).toBe(1);
  expect(useLibraryStore.getState().loadingNextPage).toBe(false);
});

test("hidden gallery pages with cursor and loadMoreHiddenItems appends", async () => {
  const hiddenA = makeItem("hidden-a", "hidden-a.jpg");
  hiddenA.hidden = true;
  const hiddenB = makeItem("hidden-b", "hidden-b.jpg");
  hiddenB.hidden = true;

  useLibraryStore.setState({
    hiddenItems: [],
    hiddenCount: 0,
    hiddenCursor: null,
    hiddenHasMore: false,
    hiddenLoading: false,
  });
  vi.mocked(tauri.library.getHiddenItems)
    .mockResolvedValueOnce({
      items: [hiddenA],
      hasMore: true,
      nextCursor: "hidden-2",
      totalCount: 2,
    })
    .mockResolvedValueOnce({
      items: [hiddenB],
      hasMore: false,
      nextCursor: null,
      totalCount: null,
    });
  (window as any).__TAURI_INTERNALS__ = {};

  await useLibraryStore.getState().loadHiddenItems();
  expect(useLibraryStore.getState().hiddenItems.map((item) => item.id)).toEqual(["hidden-a"]);
  expect(useLibraryStore.getState().hiddenCursor).toBe("hidden-2");
  expect(useLibraryStore.getState().hiddenHasMore).toBe(true);
  expect(useLibraryStore.getState().hiddenCount).toBe(2);

  await useLibraryStore.getState().loadMoreHiddenItems();
  expect(useLibraryStore.getState().hiddenItems.map((item) => item.id)).toEqual([
    "hidden-a",
    "hidden-b",
  ]);
  expect(useLibraryStore.getState().hiddenHasMore).toBe(false);
  expect(useLibraryStore.getState().hiddenCount).toBe(2);

  delete (window as any).__TAURI_INTERNALS__;
});

test("selectAll with more pages on the server selects every match without loading the window", async () => {
  const items = [makeItem("a", "a.jpg"), makeItem("b", "b.mp4", false, "video")];
  useLibraryStore.setState({
    items,
    totalCount: 5_000,
    hasMore: true,
    pageSize: 250,
    selectedIds: [],
  });
  vi.mocked(tauri.library.getMatchingIds).mockResolvedValue(["a", "b", "c", "d", "e"]);

  useLibraryStore.getState().selectAll();
  await vi.waitFor(() => {
    expect(useLibraryStore.getState().selectedIds).toEqual(["a", "b", "c", "d", "e"]);
  });
});

test("toggleSelectAll deselects everything when the full match set is selected", async () => {
  const items = [makeItem("a", "a.jpg")];
  useLibraryStore.setState({
    items,
    totalCount: 3,
    hasMore: true,
    selectedIds: ["a", "b", "c"],
  });

  useLibraryStore.getState().toggleSelectAll();
  expect(useLibraryStore.getState().selectedIds).toEqual([]);
});

type PageResult = {
  items: MediaItem[];
  hasMore: boolean;
  nextCursor: string | null;
  totalCount: number | null;
};

function deferredPage() {
  let resolve!: (value: PageResult) => void;
  const promise = new Promise<PageResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("a superseded continuation page cannot clear loadingNextPage for the newer request", async () => {
  (window as any).__TAURI_INTERNALS__ = {};
  const stale = deferredPage();
  const firstPage = deferredPage();
  const fresh = deferredPage();
  vi.mocked(tauri.library.getItems)
    .mockReturnValueOnce(stale.promise)
    .mockReturnValueOnce(firstPage.promise)
    .mockReturnValueOnce(fresh.promise);

  const a = makeItem("a", "a.jpg");
  const staleB = makeItem("stale-b", "stale-b.jpg");
  const c = makeItem("c", "c.jpg");

  useLibraryStore.setState({
    items: [a],
    page: 0,
    hasMore: true,
    nextCursor: "page-2",
    loadingNextPage: false,
  });

  // Request 1 reads cursor page-2 and stays in flight.
  const staleRequest = useLibraryStore.getState().loadNextPage();
  expect(useLibraryStore.getState().loadingNextPage).toBe(true);

  // A filter reload supersedes it; `loadItemsPage` resets the paging state.
  const reload = useLibraryStore.getState().loadItemsPage();
  firstPage.resolve({ items: [a], hasMore: true, nextCursor: "page-2", totalCount: 11 });
  await reload;
  expect(useLibraryStore.getState().loadingNextPage).toBe(false);

  // Request 2 starts on the reloaded list.
  const freshRequest = useLibraryStore.getState().loadNextPage();
  expect(useLibraryStore.getState().loadingNextPage).toBe(true);

  // The superseded request finishing late must not clear request 2's guard nor
  // append its page to the reloaded list.
  stale.resolve({ items: [staleB], hasMore: true, nextCursor: "page-3", totalCount: 11 });
  await staleRequest;
  expect(useLibraryStore.getState().loadingNextPage).toBe(true);
  expect(useLibraryStore.getState().items.map((item) => item.id)).toEqual(["a"]);

  fresh.resolve({ items: [c], hasMore: false, nextCursor: null, totalCount: 11 });
  await freshRequest;
  expect(useLibraryStore.getState().loadingNextPage).toBe(false);
  expect(useLibraryStore.getState().items.map((item) => item.id)).toEqual(["a", "c"]);
  delete (window as any).__TAURI_INTERNALS__;
});

test("a stale hidden-page request cannot clear hiddenLoading for a newer refetch", async () => {
  (window as any).__TAURI_INTERNALS__ = {};
  const stale = deferredPage();
  const refetch = deferredPage();
  vi.mocked(tauri.library.getHiddenItems)
    .mockReturnValueOnce(stale.promise)
    .mockReturnValueOnce(refetch.promise);

  const hiddenA = makeItem("hidden-a", "hidden-a.jpg");
  hiddenA.hidden = true;
  const hiddenB = makeItem("hidden-b", "hidden-b.jpg");
  hiddenB.hidden = true;

  useLibraryStore.setState({
    hiddenItems: [hiddenA],
    hiddenCount: 2,
    hiddenCursor: "hidden-2",
    hiddenHasMore: true,
    hiddenLoading: false,
  });

  const staleRequest = useLibraryStore.getState().loadMoreHiddenItems();
  expect(useLibraryStore.getState().hiddenLoading).toBe(true);

  // Opening the Hidden view refetches from the first page while the older
  // continuation request is still in flight.
  const refetchRequest = useLibraryStore.getState().loadHiddenItems();
  expect(useLibraryStore.getState().hiddenLoading).toBe(true);

  stale.resolve({ items: [hiddenB], hasMore: false, nextCursor: null, totalCount: 2 });
  await staleRequest;
  expect(useLibraryStore.getState().hiddenLoading).toBe(true);
  expect(useLibraryStore.getState().hiddenItems.map((item) => item.id)).toEqual(["hidden-a"]);

  refetch.resolve({ items: [hiddenA, hiddenB], hasMore: false, nextCursor: null, totalCount: 2 });
  await refetchRequest;
  expect(useLibraryStore.getState().hiddenLoading).toBe(false);
  expect(useLibraryStore.getState().hiddenItems.map((item) => item.id)).toEqual([
    "hidden-a",
    "hidden-b",
  ]);
  delete (window as any).__TAURI_INTERNALS__;
});

describe("showNotice", () => {
  it("carries an optional action and clears it when the notice empties", () => {
    useLibraryStore.getState().showNotice("deleted", undefined, {
      label: "Undo",
      run: () => {},
    });
    expect(useLibraryStore.getState().noticeAction?.label).toBe("Undo");

    useLibraryStore.getState().showNotice("");
    expect(useLibraryStore.getState().noticeAction).toBeNull();
    expect(useLibraryStore.getState().notice).toBe("");
  });

  it("drops a stale action when the next notice has none", () => {
    useLibraryStore.getState().showNotice("first", undefined, {
      label: "Undo",
      run: () => {},
    });
    useLibraryStore.getState().showNotice("second");
    expect(useLibraryStore.getState().noticeAction).toBeNull();
  });

  it("keeps a later notice when an earlier notice's timer fires", () => {
    vi.useFakeTimers();
    try {
      useLibraryStore.getState().showNotice("Importing 3 file(s)…");
      vi.advanceTimersByTime(1000);
      useLibraryStore.getState().showNotice("Moved 3 items to Trash.", undefined, {
        label: "Undo",
        run: () => {},
      });

      // The first notice's 3.6 s timer fires here; the Undo toast must stay.
      vi.advanceTimersByTime(3000);
      expect(useLibraryStore.getState().notice).toBe("Moved 3 items to Trash.");
      expect(useLibraryStore.getState().noticeAction?.label).toBe("Undo");

      // Its own 10 s dwell still clears it.
      vi.advanceTimersByTime(7000);
      expect(useLibraryStore.getState().notice).toBe("");
      expect(useLibraryStore.getState().noticeAction).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hidden view server-side filtering", () => {
  beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = {};
    useLibraryStore.setState({ hiddenFilter: "All", hiddenQuery: "" });
  });
  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("loads hidden items with the mapped filter when setHiddenFilter changes", async () => {
    useLibraryStore.getState().setHiddenFilter("Videos");

    expect(tauri.library.getHiddenItems).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "video", hidden: true }),
    );
  });

  it("loads hidden items with the Favorites filter as favorite-only", async () => {
    useLibraryStore.getState().setHiddenFilter("Favorites");

    expect(tauri.library.getHiddenItems).toHaveBeenCalledWith(
      expect.objectContaining({ favorite: true, hidden: true }),
    );
  });

  it("loads bare hidden items again when the filter returns to All", async () => {
    useLibraryStore.getState().setHiddenFilter("Photos");
    useLibraryStore.getState().clearHiddenFilters();

    expect(tauri.library.getHiddenItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: expect.any(Number) }),
    );
    const filter = vi.mocked(tauri.library.getHiddenItems).mock.calls[
      vi.mocked(tauri.library.getHiddenItems).mock.calls.length - 1
    ][0]!;
    expect(filter.kind).toBeUndefined();
    expect(filter.query).toBeUndefined();
  });

  it("passes a debounced query through to get_hidden_items", async () => {
    vi.useFakeTimers();
    useLibraryStore.getState().setHiddenQuery("holiday");
    expect(tauri.library.getHiddenItems).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(tauri.library.getHiddenItems).toHaveBeenCalledWith(
      expect.objectContaining({ query: "holiday", hidden: true }),
    );
    vi.useRealTimers();
  });

  it("continuation pages carry the same filter", async () => {
    useLibraryStore.setState({ hiddenFilter: "Photos" });
    vi.mocked(tauri.library.getHiddenItems).mockResolvedValueOnce({
      items: [makeItem("a", "a.jpg")],
      hasMore: true,
      nextCursor: "cursor-2",
      totalCount: 10,
    } as never);

    await useLibraryStore.getState().loadHiddenItems();
    expect(tauri.library.getHiddenItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "photo" }),
    );

    await useLibraryStore.getState().loadMoreHiddenItems();
    const filter = vi.mocked(tauri.library.getHiddenItems).mock.calls[
      vi.mocked(tauri.library.getHiddenItems).mock.calls.length - 1
    ][0]!;
    expect(filter.kind).toBe("photo");
    expect(filter.cursor).toBe("cursor-2");
  });
});

test("reorderAlbums reorders the two derived lists and persists the order", async () => {
  const overviews = [
    {
      id: "one",
      name: "One",
      colorIndex: 0,
      createdAt: 1,
      updatedAt: 1,
      itemCount: 0,
      coverItems: [],
      itemSize: 0,
    },
    {
      id: "two",
      name: "Two",
      colorIndex: 0,
      createdAt: 2,
      updatedAt: 2,
      itemCount: 0,
      coverItems: [],
      itemSize: 0,
    },
    {
      id: "three",
      name: "Three",
      colorIndex: 0,
      createdAt: 3,
      updatedAt: 3,
      itemCount: 0,
      coverItems: [],
      itemSize: 0,
    },
  ];
  useLibraryStore.setState({
    albums: overviews.map(({ id, name, colorIndex, createdAt, updatedAt, itemCount }) => ({
      id,
      name,
      colorIndex,
      createdAt,
      updatedAt,
      itemCount,
      itemSize: 0,
      itemIds: [],
    })),
    albumOverviews: overviews as any,
  });

  const ok = await useLibraryStore.getState().reorderAlbums(["three", "one", "two"]);

  expect(ok).toBe(true);
  expect(useLibraryStore.getState().albums.map((a) => a.id)).toEqual(["three", "one", "two"]);
  expect(useLibraryStore.getState().albumOverviews.map((a) => a.id)).toEqual([
    "three",
    "one",
    "two",
  ]);
  expect(tauri.albums.reorder).toHaveBeenCalledWith(["three", "one", "two"]);
});

test("reorderAlbums reverts both derived lists when the backend rejects the order", async () => {
  const overviews = [
    {
      id: "one",
      name: "One",
      colorIndex: 0,
      createdAt: 1,
      updatedAt: 1,
      itemCount: 0,
      coverItems: [],
      itemSize: 0,
    },
    {
      id: "two",
      name: "Two",
      colorIndex: 0,
      createdAt: 2,
      updatedAt: 2,
      itemCount: 0,
      coverItems: [],
      itemSize: 0,
    },
  ];
  useLibraryStore.setState({
    albums: overviews.map(({ id, name, colorIndex, createdAt, updatedAt, itemCount }) => ({
      id,
      name,
      colorIndex,
      createdAt,
      updatedAt,
      itemCount,
      itemSize: 0,
      itemIds: [],
    })),
    albumOverviews: overviews as any,
  });
  (tauri.albums.reorder as any).mockRejectedValue(new Error("stale album list"));

  const ok = await useLibraryStore.getState().reorderAlbums(["two", "one"]);

  expect(ok).toBe(false);
  expect(useLibraryStore.getState().albums.map((a) => a.id)).toEqual(["one", "two"]);
  expect(useLibraryStore.getState().albumOverviews.map((a) => a.id)).toEqual(["one", "two"]);
});
