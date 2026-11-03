import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type {
  MediaItem,
  Album,
  Tag,
  ImportSession,
  LibraryFilter,
  DuplicateGroup,
  Filter,
  LayoutMode,
  Screen,
} from "../types/media";
import type {
  AlbumOverview,
  LibraryFolder,
  LibraryFilterDTO,
  LibraryItemsPage,
  SmartAlbum,
  SmartAlbumFilter,
} from "../types/commands";
import { tauri } from "../commands/tauri";
import { formatBytes } from "../commands/tauri";

function mergeDuplicateGroups(
  previous: DuplicateGroup[],
  current: DuplicateGroup[],
): DuplicateGroup[] {
  // Merge by sha256, preferring groups from current (which has newer hashes)
  // but keeping any previous groups that aren't in current.
  const byHash = new Map<string, DuplicateGroup>();
  for (const g of current) {
    byHash.set(g.sha256, g);
  }
  for (const g of previous) {
    if (!byHash.has(g.sha256)) {
      byHash.set(g.sha256, g);
    }
  }
  // Sort: largest groups first, then by size
  return [...byHash.values()].sort(
    (a, b) => b.items.length - a.items.length || b.size - a.size,
  );
}

interface LibraryState {
  // Data
  items: MediaItem[];
  albums: Album[];
  albumOverviews: AlbumOverview[];
  smartAlbums: SmartAlbum[];
  tags: Tag[];
  duplicates: DuplicateGroup[];
  folders: LibraryFolder[];

  // UI State
  // inspectedId = inspection focus (single-click, Inspector, viewer cursor).
  // selectedIds = multi-selection set (checkbox / "+" / select-all, batch ops).
  // The two are independent: inspecting an item never mutates the selection,
  // and changing the selection never moves inspection.
  inspectedId: string | null;
  selectedIds: string[];
  filter: Filter;
  query: string;
  // Hidden has its own filter/search so travelling through the viewer or back
  // to Library does not rewrite either screen's view.
  hiddenFilter: Filter;
  hiddenQuery: string;
  layout: LayoutMode;
  sortBy: "capturedAt" | "modifiedAt" | "name" | "size" | "kind";
  sortOrder: "asc" | "desc";
  showInspector: boolean;
  sidebarOpen: boolean;
  activeAlbum: string | null;
  activeSmartAlbum: string | null;
  // Source filter (a library folder path). Independent of `filter`, which is
  // the media-kind filter; the two compose so "Photos inside Pictures" works.
  activeSource: string | null;
  // Capture-date range. Null means open-ended; the backend falls back to file
  // modification time when an item has no EXIF capture date.
  dateFrom: number | null;
  dateTo: number | null;
  screen: Screen;
  // Rating and color-label filters (applied on top of `filter`)
  minRating: number | null; // items at or above this star rating
  colorLabelFilter: string | null; // 'red' | 'yellow' | 'green' | 'blue' | 'purple'
  cameraFilter: string | null; // filter by camera model
  lensFilter: string | null; // filter by lens model
  // Which collection the viewer navigates when it opens. Hidden items are
  // deliberately absent from the normal viewer, so the Hidden gallery asks the
  // viewer to browse the hidden set instead.
  viewerScope: "library" | "hidden";

  // Pagination
  page: number;
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  totalCount: number;
  /** A background page request; unlike a scan it must not block the UI. */
  loadingNextPage: boolean;

  // Status
  busy: boolean;
  canceling: boolean;
  refreshingLibrary: boolean;
  progress: {
    phase: string;
    processed: number;
    total: number;
    bytesProcessed?: number;
    bytesTotal?: number;
    filesProcessed?: number;
    filesTotal?: number;
    currentFile?: string;
  } | null;
  notice: string | null;

  // Computed
  visibleItems: MediaItem[];
  sortedItems: MediaItem[];
  playableItems: MediaItem[];
  viewerItems: MediaItem[];
  viewerSelected: MediaItem | null;
  currentIndex: number;
  viewerIndex: number;
  hiddenItems: MediaItem[];
  hiddenCount: number;

  // Internal sort cache (per-store-instance, replaces module-level vars)
  _sortedSource: MediaItem[] | null;
  _sortedBy: LibraryState["sortBy"] | null;
  _sortedOrder: LibraryState["sortOrder"] | null;
  _sortedCache: MediaItem[];

  // Per-album item cache (all items in an album, not paginated)
  albumItems: Record<string, MediaItem[]>;
  // Actions - Data Loading
  loadLibrary: (filter?: LibraryFilter) => Promise<void>;
  loadNextPage: () => Promise<void>;
  loadFolders: () => Promise<void>;
  removeFolder: (path: string, deleteFiles?: boolean) => Promise<number>;
  importFolder: () => Promise<void>;
  importFiles: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshDerived: () => void;
  navigatePhoto: (delta: number) => void;
  navigateViewerPhoto: (delta: number) => void;

  // Actions - Inspection & Selection (independent concepts)
  inspectItem: (id: string | null) => void;
  toggleSelection: (id: string) => void;
  selectRange: (startId: string, endId: string) => void;
  clearSelection: () => void;
  selectAll: () => void;
  toggleSelectAll: () => void;
  addToSelection: (id: string) => void;
  setSelectedIds: (ids: string[]) => void;

  // Actions - Filters & View
  setFilter: (filter: Filter) => void;
  setHiddenFilter: (filter: Filter) => void;
  clearFilters: () => void;
  clearHiddenFilters: () => void;
  setActiveSource: (path: string | null) => void;
  setQuery: (query: string) => void;
  setHiddenQuery: (query: string) => void;
  setMinRating: (rating: number | null) => void;
  setColorLabelFilter: (colorLabel: string | null) => void;
  setCameraFilter: (camera: string | null) => void;
  setLensFilter: (lens: string | null) => void;
  setLayout: (layout: LayoutMode) => void;
  setDateRange: (from: number | null, to: number | null) => void;
  setSort: (
    sortBy: LibraryState["sortBy"],
    sortOrder: LibraryState["sortOrder"],
  ) => void;
  setScreen: (screen: Screen) => void;
  setViewerScope: (scope: "library" | "hidden") => void;
  toggleInspector: () => void;
  toggleSidebar: () => void;
  setActiveAlbum: (albumId: string | null) => void;

  // Actions - Items
  toggleFavorite: (id: string) => Promise<void>;
  toggleHidden: (id: string) => Promise<void>;
  setFavoriteForIds: (ids: string[], favorite: boolean) => Promise<void>;
  setHiddenForIds: (ids: string[], hidden: boolean) => Promise<void>;
  setRating: (id: string, rating: number) => Promise<void>;
  setColorLabel: (id: string, colorLabel: string) => Promise<void>;
  setRatingForIds: (ids: string[], rating: number) => Promise<void>;
  setColorLabelForIds: (ids: string[], colorLabel: string) => Promise<void>;
  updateItemTags: (id: string, tags: string[]) => Promise<void>;
  deleteItems: (ids: string[]) => Promise<void>;

  // Actions - Albums
  createAlbum: (name: string, itemIds?: string[]) => Promise<void>;
  deleteAlbum: (albumId: string) => Promise<void>;
  renameAlbum: (albumId: string, name: string) => Promise<void>;
  addToAlbum: (albumId: string, itemIds?: string[]) => Promise<void>;
  removeFromAlbum: (albumId: string, itemIds: string[]) => Promise<void>;
  loadAlbumItems: (albumId: string) => Promise<void>;

  // Actions - Smart Albums
  loadSmartAlbums: () => Promise<void>;
  createSmartAlbum: (name: string) => Promise<void>;
  renameSmartAlbum: (albumId: string, name: string) => Promise<void>;
  deleteSmartAlbum: (albumId: string) => Promise<void>;
  openSmartAlbum: (albumId: string) => Promise<void>;

  // Actions - Duplicates
  scanDuplicates: () => Promise<void>;
  cancelScan: () => Promise<void>;
  clearDuplicates: () => void;

  // Actions - UI
  setBusy: (busy: boolean) => void;
  setProgress: (progress: LibraryState["progress"]) => void;
  showNotice: (text: string) => void;
}

// Sorting is the most expensive part of deriving the gallery collections.
// Keep it stable across query, selection, and screen changes, which do not
// replace the underlying items or alter the sort order. Cache lives on the
// store instance (see _sortedSource / _sortedBy / _sortedOrder / _sortedCache)
// Load generation and query debounce are per-app (not per-store-instance).
let libraryLoadGeneration = 0;
let queryReloadTimer: ReturnType<typeof setTimeout> | null = null;
// Debounce for free-text camera/lens filters so typing doesn't reload the
// library on every keystroke. State updates stay immediate; only the IPC
// round-trip is deferred.
let cameraLensReloadTimer: ReturnType<typeof setTimeout> | null = null;

function currentLibraryFilter(state: LibraryState): LibraryFilterDTO {
  const kind =
    state.filter === "Photos"
      ? "photo"
      : state.filter === "Videos"
        ? "video"
        : state.filter === "RAW"
          ? "raw"
          : undefined;
  return {
    kind,
    favorite: state.filter === "Favorites" ? true : undefined,
    albumId: state.activeAlbum ?? undefined,
    query: state.query.trim() || undefined,
    sourcePath: state.activeSource ?? undefined,
    dateFrom: state.dateFrom ?? undefined,
    dateTo: state.dateTo ?? undefined,
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    rating: state.minRating ?? undefined,
    colorLabel: state.colorLabelFilter ?? undefined,
    camera: state.cameraFilter ?? undefined,
    lens: state.lensFilter ?? undefined,
  };
}

export function resetSortedItemsCache(): void {
  // No-op: sort cache is now per-store-instance in state.
}

function getSortedItems(
  state: LibraryState,
  items: MediaItem[],
  sortBy: LibraryState["sortBy"],
  sortOrder: LibraryState["sortOrder"],
) {
  if (
    items === state._sortedSource &&
    sortBy === state._sortedBy &&
    sortOrder === state._sortedOrder
  )
    return state._sortedCache;
  state._sortedSource = items;
  state._sortedBy = sortBy;
  state._sortedOrder = sortOrder;
  state._sortedCache = [...items].sort((a, b) => {
    let comparison = 0;
    switch (sortBy) {
      case "name":
        comparison = a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        break;
      case "size":
        comparison = a.size - b.size;
        break;
      case "kind":
        comparison = a.kind.localeCompare(b.kind);
        break;
      case "modifiedAt":
        comparison = a.modifiedAt - b.modifiedAt;
        break;
      case "capturedAt":
      default:
        comparison =
          (a.capturedAt ?? a.modifiedAt) - (b.capturedAt ?? b.modifiedAt);
        break;
    }
    if (comparison === 0)
      comparison = a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    return sortOrder === "asc" ? comparison : -comparison;
  });
  return state._sortedCache;
}

function computeInspectionDerived(state: LibraryState) {
  const viewerSelected =
    state.viewerItems.find((item) => item.id === state.inspectedId) ||
    state.viewerItems[0] ||
    null;
  return {
    viewerSelected,
    currentIndex: Math.max(
      0,
      state.playableItems.findIndex((item) => item.id === state.inspectedId),
    ),
    viewerIndex: viewerSelected
      ? state.viewerItems.findIndex((item) => item.id === viewerSelected.id)
      : -1,
  };
}

function computeDerived(state: LibraryState) {
  const {
    items,
    filter,
    query,
    activeAlbum,
    activeSource,
    inspectedId,
    viewerScope,
    sortBy,
    sortOrder,
  } = state;

  // One sort for every derived collection. Hidden items are a separate,
  // first-class set: they never appear in the normal grid, viewer, album
  // covers, or counts.
  const sorted = getSortedItems(state, items, sortBy, sortOrder);
  const hiddenItems = sorted.filter((item) => item.hidden);
  let visible = sorted.filter((item) => !item.hidden);

  visible = visible.filter((item) => {
    if (filter === "Photos" && item.kind !== "photo") return false;
    if (filter === "Videos" && item.kind !== "video") return false;
    if (filter === "RAW" && item.kind !== "raw") return false;
    if (filter === "Favorites" && !item.favorite) return false;
    return true;
  });

  if (activeAlbum) {
    // Album membership is hydrated onto each item as `albumIds`; the album
    // list itself only carries an item count, so filter by membership rather
    // than expecting the backend to echo every item id back on the album.
    visible = visible.filter((item) => item.albumIds?.includes(activeAlbum));
  }

  if (query.trim()) {
    const normalized = query.trim().toLowerCase();
    visible = visible.filter((item) =>
      `${item.name} ${item.path} ${item.extension} ${item.kind} ${item.camera || ""} ${item.lens || ""} ${(item.tags || []).join(" ")}`
        .toLowerCase()
        .includes(normalized),
    );
  }

  // Source filter: only items physically inside the selected source folder.
  // Uses a real path boundary so /Photos never matches /Photos2.
  if (activeSource) {
    const prefix = activeSource.endsWith("/")
      ? activeSource
      : `${activeSource}/`;
    visible = visible.filter(
      (item) => item.path === activeSource || item.path.startsWith(prefix),
    );
  }

  const playable = visible.filter(
    (item) => item.kind === "photo" || item.kind === "video",
  );
  const viewerPool =
    viewerScope === "hidden"
      ? hiddenItems
      : sorted.filter((item) => !item.hidden);
  const viewer = viewerPool.filter(
    (item) =>
      item.kind === "photo" || item.kind === "video" || item.kind === "raw",
  );
  const viewerSelected =
    viewer.find((item) => item.id === inspectedId) || viewer[0] || null;
  const currentIndex = Math.max(
    0,
    playable.findIndex((item) => item.id === inspectedId),
  );
  const viewerIndex = viewerSelected
    ? viewer.findIndex((item) => item.id === viewerSelected.id)
    : -1;

  return {
    visibleItems: visible,
    sortedItems: sorted,
    playableItems: playable,
    viewerItems: viewer,
    viewerSelected,
    currentIndex,
    viewerIndex,
    hiddenItems,
    hiddenCount: hiddenItems.length,
  };
}

export const useLibraryStore = create<LibraryState>()(
  devtools(
    (set, get) => ({
      // Initial State
      items: [],
      albums: [],
      albumOverviews: [],
      smartAlbums: [],
      tags: [],
      duplicates: [],
      folders: [],
      inspectedId: null,
      selectedIds: [],
      filter: "All",
      query: "",
      hiddenFilter: "All",
      hiddenQuery: "",
      layout: "grid",
      sortBy: "capturedAt",
      sortOrder: "desc",
      showInspector: true,
      sidebarOpen: true,
      activeAlbum: null,
      activeSmartAlbum: null,
      activeSource: null,
      dateFrom: null,
      dateTo: null,
      screen: "Library",
      viewerScope: "library",
      minRating: null,
      colorLabelFilter: null,
      cameraFilter: null,
      lensFilter: null,
      busy: false,
      canceling: false,
      refreshingLibrary: false,
      progress: null,
      notice: null,

      // Pagination
      page: 0,
      pageSize: 250,
      hasMore: false,
      nextCursor: null,
      totalCount: 0,
      loadingNextPage: false,

      // Computed (updated via subscribe in components)
      visibleItems: [],
      sortedItems: [],
      playableItems: [],
      viewerItems: [],
      viewerSelected: null,
      currentIndex: 0,
      viewerIndex: -1,
      hiddenItems: [],
      hiddenCount: 0,

      // Internal sort cache (per-store-instance)
      _sortedSource: null,
      _sortedBy: null,
      _sortedOrder: null,
      _sortedCache: [],

      // Per-album item cache (all items in an album, not paginated)
      albumItems: {},
      // Data Loading
      loadLibrary: async (filter) => {
        const generation = ++libraryLoadGeneration;
        set({
          // A paged catalog query is not a scan. Keeping it out of the
          // blocking busy/progress state lets filter clicks stay cheap and
          // avoids flashing the full importer UI for ordinary refinements.
          refreshingLibrary: true,
          page: 0,
          hasMore: false,
          nextCursor: null,
          loadingNextPage: false,
        });
        try {
          const state = get();
          const dto: LibraryFilterDTO = {
            ...currentLibraryFilter(state),
            ...(filter || {}),
            limit: state.pageSize,
            cursor: undefined,
          };

          const isTauri =
            typeof window !== "undefined" &&
            ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
          if (!isTauri) {
            if (import.meta.env.DEV)
              console.warn(
                "Tauri IPC is not available in browser preview mode.",
              );
            set({ refreshingLibrary: false });
            get().refreshDerived();
            return;
          }

          const [pageResult, albumOverviews, smartAlbums, tags, folders] =
            await Promise.all([
              tauri.library.getItems(dto),
              tauri.albums.getOverviews(),
              tauri.smartAlbums.get(),
              tauri.albums.getTags(),
              tauri.library.getFolders(),
            ]);
          if (generation !== libraryLoadGeneration) return;
          // Cards only need counts and a bounded cover set. The full
          // membership is fetched when an album is opened.
          const albums: Album[] = albumOverviews.map((album) => ({
            id: album.id,
            name: album.name,
            colorIndex: album.colorIndex,
            itemCount: album.itemCount,
            itemIds: [],
            createdAt: album.createdAt,
            updatedAt: album.updatedAt,
          }));
          // Supports the old array response in browser fixtures while native
          // callers use the bounded page contract.
          const page: LibraryItemsPage = Array.isArray(pageResult)
            ? { items: pageResult, hasMore: false, totalCount: pageResult.length }
            : pageResult;

          set({
            items: page.items,
            albums,
            albumOverviews,
            smartAlbums,
            tags,
            folders,
            refreshingLibrary: false,
            page: 0,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor ?? null,
            totalCount: page.totalCount ?? 0,
          });
          get().refreshDerived();
        } catch (e) {
          // A superseded request must not end the newer request's spinner or
          // report a stale failure to the user.
          if (generation !== libraryLoadGeneration) return;
          if (import.meta.env.DEV) console.error("loadLibrary failed:", e);
          set({
            refreshingLibrary: false,
            notice: "Failed to load library: " + String(e),
          });
        }
      },

      loadNextPage: async () => {
        const state = get();
        if (state.busy || !state.hasMore || !state.nextCursor) return;
        const cursor = state.nextCursor;
        const generation = libraryLoadGeneration;
        // Fetch continuation pages quietly. Marking the whole library busy here
        // would disable controls and show a misleading cancellable scan toast
        // every time the user reaches the bottom of the grid.
        set({ loadingNextPage: true });
        try {
          const pageResult = await tauri.library.getItems({
            ...currentLibraryFilter(get()),
            limit: state.pageSize,
            cursor,
          });
          if (generation !== libraryLoadGeneration) {
            // A filter/sort reload superseded this continuation request. Do
            // not leave the quiet paging guard stuck on if the old request
            // happens to finish after the replacement load.
            set({ loadingNextPage: false });
            return;
          }
          const page: LibraryItemsPage = Array.isArray(pageResult)
            ? { items: pageResult, hasMore: false, totalCount: pageResult.length }
            : pageResult;
          set((current) => {
            const known = new Set(current.items.map((item) => item.id));
            const additions = page.items.filter((item) => !known.has(item.id));
            return {
              items: [...current.items, ...additions],
              page: current.page + 1,
              hasMore: page.hasMore,
              nextCursor: page.nextCursor ?? null,
              totalCount: page.totalCount ?? current.totalCount,
              loadingNextPage: false,
            };
          });
          get().refreshDerived();
        } catch (error) {
          if (generation !== libraryLoadGeneration) {
            set({ loadingNextPage: false });
            return;
          }
          set({
            loadingNextPage: false,
            notice: "Failed to load more items: " + String(error),
          });
        }
      },

      importFolder: async () => {
        // Implemented in App.tsx via dialog
      },

      loadFolders: async () => {
        const isTauri =
          typeof window !== "undefined" &&
          ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
        if (!isTauri) return;
        try {
          const folders = await tauri.library.getFolders();
          set({ folders });
        } catch (e) {
          if (import.meta.env.DEV) console.error("loadFolders failed:", e);
        }
      },

      // Removing a folder only touches the catalog unless the caller asks for
      // the originals to be trashed as well.
      removeFolder: async (path, deleteFiles = false) => {
        const removed = await tauri.library.removeFolder(path, deleteFiles);

        const prefix = path.endsWith("/") ? path : `${path}/`;
        const removedIds = new Set(
          get()
            .items.filter(
              (item) => item.path === path || item.path.startsWith(prefix),
            )
            .map((item) => item.id),
        );

        set((s) => ({
          items: s.items.filter((item) => !removedIds.has(item.id)),
          selectedIds: s.selectedIds.filter((id) => !removedIds.has(id)),
          // Never leave inspection pointing at an item that no longer exists.
          inspectedId:
            s.inspectedId && removedIds.has(s.inspectedId)
              ? null
              : s.inspectedId,
          folders: s.folders.filter((folder) => folder.path !== path),
          // Drop a source filter that pointed into the removed folder.
          activeSource:
            s.activeSource === path ||
            (s.activeSource && s.activeSource.startsWith(prefix))
              ? null
              : s.activeSource,
        }));
        get().refreshDerived();
        await get().loadFolders();

        return removed;
      },

      importFiles: async () => {
        // Implemented in App.tsx via dialog
      },

      refresh: async () => {
        await get().loadLibrary();
      },

      // Inspection & selection are independent. Inspecting an item never
      // touches the selection set; selection ops never move inspection.
      // Single-click inspects, checkbox/"+" toggles selection membership,
      // double-click inspects + opens the viewer on that item.
      inspectItem: (id) => {
        const state = get();
        if (id === state.inspectedId) return;
        if (id !== null && !state.items.some((i) => i.id === id)) return;
        const next = { ...state, inspectedId: id };
        set({ inspectedId: id, ...computeInspectionDerived(next) });
      },

      toggleSelection: (id) => {
        const { selectedIds } = get();
        const next = selectedIds.includes(id)
          ? selectedIds.filter((s) => s !== id)
          : [...selectedIds, id];
        set({ selectedIds: next });
      },

      addToSelection: (id: string) => {
        const { selectedIds } = get();
        // Purely additive - toggling would silently drop the item the
        // inspector is currently showing.
        if (selectedIds.includes(id)) return;
        set({ selectedIds: [...selectedIds, id] });
      },

      // Arrow-key / slideshow / viewer navigation moves inspection only;
      // it never rewrites the user's multi-selection.
      navigatePhoto: (delta) => {
        const { playableItems, inspectedId: currentId } = get();
        if (playableItems.length === 0) return;
        const currentIndex = playableItems.findIndex((i) => i.id === currentId);
        const nextIndex =
          (currentIndex + delta + playableItems.length) % playableItems.length;
        const state = get();
        const inspectedId = playableItems[nextIndex].id;
        set({
          inspectedId,
          ...computeInspectionDerived({ ...state, inspectedId }),
        });
      },

      navigateViewerPhoto: (delta) => {
        const { viewerItems, viewerSelected } = get();
        if (viewerItems.length === 0 || !viewerSelected) return;
        const currentIndex = viewerItems.findIndex(
          (i) => i.id === viewerSelected.id,
        );
        const nextIndex =
          (currentIndex + delta + viewerItems.length) % viewerItems.length;
        const state = get();
        const inspectedId = viewerItems[nextIndex].id;
        set({
          inspectedId,
          ...computeInspectionDerived({ ...state, inspectedId }),
        });
      },

      selectRange: (startId, endId) => {
        const { visibleItems } = get();
        const start = visibleItems.findIndex((i) => i.id === startId);
        const end = visibleItems.findIndex((i) => i.id === endId);
        if (start === -1 || end === -1) return;

        const [from, to] = start < end ? [start, end] : [end, start];
        const rangeIds = visibleItems.slice(from, to + 1).map((i) => i.id);
        set({ selectedIds: rangeIds });
      },

      // Clearing the selection leaves inspection untouched, so the Inspector
      // keeps showing the inspected item even with an empty selection set.
      clearSelection: () => set({ selectedIds: [] }),

      toggleSelectAll: () => {
        const { visibleItems, selectedIds } = get();
        if (selectedIds.length === visibleItems.length) {
          // Currently all selected, deselect all (inspection untouched)
          set({ selectedIds: [] });
        } else {
          // Not all selected, select all visible
          set({ selectedIds: visibleItems.map((i) => i.id) });
        }
      },

      selectAll: () => {
        const { visibleItems } = get();
        set({ selectedIds: visibleItems.map((i) => i.id) });
      },

      // The Hidden gallery owns its own item list, so it needs a way to replace
      // the shared selection without going through `visibleItems`.
      setSelectedIds: (ids) => {
        set({ selectedIds: [...new Set(ids)] });
      },

      // Filters & View
      setFilter: (filter) => {
        set({
          filter,
          activeAlbum: filter === "Favorites" ? null : get().activeAlbum,
          activeSmartAlbum: null,
        });
        get().refreshDerived();
        void get().loadLibrary();
      },

      clearFilters: () => {
        set({
          filter: "All",
          query: "",
          activeSource: null,
          minRating: null,
          colorLabelFilter: null,
          cameraFilter: null,
          lensFilter: null,
          dateFrom: null,
          dateTo: null,
          activeSmartAlbum: null,
        });
        get().refreshDerived();
        void get().loadLibrary();
      },

      clearHiddenFilters: () => set({ hiddenFilter: "All", hiddenQuery: "" }),

      setHiddenFilter: (hiddenFilter) => set({ hiddenFilter }),

      setActiveSource: (path) => {
        // Toggle off when the active source is clicked again; picking a source
        // leaves any album so the two scopes never stack invisibly.
        const next = get().activeSource === path ? null : path;
        set({
          activeSource: next,
          activeAlbum: null,
          activeSmartAlbum: null,
        });
        get().refreshDerived();
        void get().loadLibrary();
      },

      setDateRange: (dateFrom, dateTo) => {
        set({ dateFrom, dateTo, activeSmartAlbum: null });
        get().refreshDerived();
        void get().loadLibrary();
      },

      setMinRating: (rating) => {
        set({ minRating: rating, activeSmartAlbum: null });
        get().refreshDerived();
        void get().loadLibrary();
      },

      setColorLabelFilter: (colorLabel) => {
        set({ colorLabelFilter: colorLabel, activeSmartAlbum: null });
        get().refreshDerived();
        void get().loadLibrary();
      },

      setCameraFilter: (camera: string | null) => {
        set({ cameraFilter: camera, activeSmartAlbum: null });
        get().refreshDerived();
        if (cameraLensReloadTimer) clearTimeout(cameraLensReloadTimer);
        cameraLensReloadTimer = setTimeout(() => {
          cameraLensReloadTimer = null;
          void get().loadLibrary();
        }, 180);
      },

      setLensFilter: (lens: string | null) => {
        set({ lensFilter: lens, activeSmartAlbum: null });
        get().refreshDerived();
        if (cameraLensReloadTimer) clearTimeout(cameraLensReloadTimer);
        cameraLensReloadTimer = setTimeout(() => {
          cameraLensReloadTimer = null;
          void get().loadLibrary();
        }, 180);
      },

      setQuery: (query) => {
        set({ query, activeSmartAlbum: null });
        get().refreshDerived();
        if (queryReloadTimer) clearTimeout(queryReloadTimer);
        queryReloadTimer = setTimeout(() => {
          queryReloadTimer = null;
          void get().loadLibrary();
        }, 180);
      },

      setHiddenQuery: (hiddenQuery) => set({ hiddenQuery }),

      setLayout: (layout) => set({ layout }),

      setSort: (sortBy, sortOrder) => {
        set({ sortBy, sortOrder });
        get().refreshDerived();
        void get().loadLibrary();
      },

      setScreen: (screen) => set({ screen }),

      setViewerScope: (viewerScope) => {
        if (get().viewerScope === viewerScope) return;
        set({ viewerScope });
        get().refreshDerived();
      },

      toggleInspector: () => set((s) => ({ showInspector: !s.showInspector })),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

      setActiveAlbum: (albumId) => {
        set({
          activeAlbum: albumId,
          activeSmartAlbum: null,
          filter: "All",
          activeSource: null,
        });
        get().refreshDerived();
        void get().loadLibrary();
      },

      // Items
      toggleFavorite: async (id) => {
        const item = get().items.find((i) => i.id === id);
        if (!item) return;
        const next = !item.favorite;
        await tauri.items.toggleFavorite(id, next);
        set((s) => ({
          items: s.items.map((i) =>
            i.id === id ? { ...i, favorite: next } : i,
          ),
        }));
        get().refreshDerived();
      },

      setFavoriteForIds: async (ids, favorite) => {
        const targets = get().items.filter((i) => ids.includes(i.id));
        await Promise.all(
          targets.map((i) => tauri.items.toggleFavorite(i.id, favorite)),
        );
        set((s) => ({
          items: s.items.map((i) =>
            ids.includes(i.id) ? { ...i, favorite } : i,
          ),
        }));
        get().refreshDerived();
      },

      setHiddenForIds: async (ids, hidden) => {
        const targets = get().items.filter((i) => ids.includes(i.id));
        if (!targets.length) return;

        // Hiding removes an item from every visible collection; unhiding puts
        // it back. Album counts only describe visible items, so keep them in
        // step locally instead of waiting for a reload.
        const hiding = hidden ? targets.filter((i) => !i.hidden) : [];
        const showing = hidden ? [] : targets.filter((i) => i.hidden);

        await Promise.all(
          targets.map((i) => tauri.items.toggleHidden(i.id, hidden)),
        );

        // Folder counts describe the visible gallery, matching the backend.
        // Refresh them after the flag changes so the Sources summary cannot
        // keep showing a stale count that includes hidden files.
        let folders = get().folders;
        try {
          folders = await tauri.library.getFolders();
        } catch {
          // Keep the previous counts if the folder query fails; the next
          // library load will reconcile them.
        }

        set((s) => ({
          items: s.items.map((i) =>
            ids.includes(i.id) ? { ...i, hidden } : i,
          ),
          folders,
          albums: s.albums.map((album) => {
            const visibleDelta =
              showing.filter((i) => i.albumIds?.includes(album.id)).length -
              hiding.filter((i) => i.albumIds?.includes(album.id)).length;
            return {
              ...album,
              itemCount: Math.max(0, (album.itemCount || 0) + visibleDelta),
            };
          }),
          // The items just moved between collections, so they cannot stay
          // selected or inspected in the view they came from.
          selectedIds: s.selectedIds.filter((id) => !ids.includes(id)),
          inspectedId:
            s.inspectedId && ids.includes(s.inspectedId) ? null : s.inspectedId,
          duplicates: s.duplicates.map((g) => ({
            ...g,
            items: g.items.map((i) =>
              ids.includes(i.id) ? { ...i, hidden } : i,
            ),
          })),
        }));
        get().refreshDerived();
      },

      toggleHidden: async (id) => {
        const item = get().items.find((i) => i.id === id);
        if (!item) return;
        await get().setHiddenForIds([id], !item.hidden);
      },

      setRating: async (id, rating) => {
        const item = get().items.find((i) => i.id === id);
        if (!item) return;
        const prev = { ...item };
        set((s) => ({
          items: s.items.map((i) => (i.id === id ? { ...i, rating } : i)),
        }));
        get().refreshDerived();
        try {
          await tauri.items.setRating(id, rating);
        } catch (error) {
          console.error(`Failed to set rating for ${id}:`, error);
          set((s) => ({
            items: s.items.map((i) => (i.id === id ? { ...prev } : i)),
          }));
          get().refreshDerived();
        }
      },

      setColorLabel: async (id, colorLabel) => {
        const item = get().items.find((i) => i.id === id);
        if (!item) return;
        const prev = { ...item };
        set((s) => ({
          items: s.items.map((i) => (i.id === id ? { ...i, colorLabel } : i)),
        }));
        get().refreshDerived();
        try {
          await tauri.items.setColorLabel(id, colorLabel);
        } catch (error) {
          console.error(`Failed to set color label for ${id}:`, error);
          set((s) => ({
            items: s.items.map((i) => (i.id === id ? { ...prev } : i)),
          }));
          get().refreshDerived();
        }
      },

      setRatingForIds: async (ids, rating) => {
        const targets = get().items.filter((i) => ids.includes(i.id));
        if (!targets.length) return;
        const prevs = new Map(
          targets.map((i) => [i.id, { ...i }]),
        );
        set((s) => ({
          items: s.items.map((i) => (ids.includes(i.id) ? { ...i, rating } : i)),
        }));
        get().refreshDerived();
        try {
          await Promise.all(
            targets.map((i) => tauri.items.setRating(i.id, rating)),
          );
        } catch (error) {
          console.error(`Failed to set rating for ${ids.length} items:`, error);
          set((s) => ({
            items: s.items.map((i) =>
              ids.includes(i.id) ? { ...prevs.get(i.id)! } : i,
            ),
          }));
          get().refreshDerived();
        }
      },

      setColorLabelForIds: async (ids, colorLabel) => {
        const targets = get().items.filter((i) => ids.includes(i.id));
        if (!targets.length) return;
        const prevs = new Map(
          targets.map((i) => [i.id, { ...i }]),
        );
        set((s) => ({
          items: s.items.map((i) => (ids.includes(i.id) ? { ...i, colorLabel } : i)),
        }));
        get().refreshDerived();
        try {
          await Promise.all(
            targets.map((i) => tauri.items.setColorLabel(i.id, colorLabel)),
          );
        } catch (error) {
          console.error(
            `Failed to set color label for ${ids.length} items:`,
            error,
          );
          set((s) => ({
            items: s.items.map((i) =>
              ids.includes(i.id) ? { ...prevs.get(i.id)! } : i,
            ),
          }));
          get().refreshDerived();
        }
      },

      updateItemTags: async (id, tags) => {
        await tauri.items.updateTags(id, tags);
        set((s) => ({
          items: s.items.map((i) => (i.id === id ? { ...i, tags } : i)),
        }));
        get().refreshDerived();
      },

      deleteItems: async (ids) => {
        const paths = get()
          .items.filter((i) => ids.includes(i.id))
          .map((i) => i.path);
        set({
          busy: true,
          canceling: false,
          progress: { phase: "trashing", processed: 0, total: paths.length },
        });
        try {
          const result = await tauri.items.moveToTrash(paths);
          // Only remove items that were successfully trashed
          const trashedIds = new Set(
            get()
              .items.filter((i) => result.trashed.includes(i.path))
              .map((i) => i.id),
          );
          if (result.failed.length > 0) {
            const errors = result.failed
              .map((f) => `${f.path}: ${f.error}`)
              .join("; ");
            get().showNotice(
              `Failed to trash ${result.failed.length} item(s): ${errors}`,
            );
          }
          set({ busy: false, canceling: false, progress: null });
          set((s) => ({
            items: s.items.filter((i) => !trashedIds.has(i.id)),
            selectedIds: s.selectedIds.filter((id) => !trashedIds.has(id)),
            inspectedId:
              s.inspectedId && trashedIds.has(s.inspectedId)
                ? null
                : s.inspectedId,
            duplicates: s.duplicates
              .map((g) => ({
                ...g,
                items: g.items.filter((i) => !trashedIds.has(i.id)),
              }))
              .filter((g) => (g.items?.length || 0) > 1),
          }));
        } catch (e) {
          set({ busy: false, canceling: false, progress: null });
          throw e;
        }
        get().refreshDerived();
      },

      // Albums
      createAlbum: async (name, itemIds) => {
        const trimmed = name.trim();
        if (!trimmed) return;

        const album = await tauri.albums.create(trimmed);
        const ids =
          itemIds ??
          (get().selectedIds.length
            ? get().selectedIds
            : get().inspectedId
              ? [get().inspectedId!]
              : []);
        if (ids.length) await tauri.albums.addItems(album.id, ids);

        // Reflect the new membership immediately. The album response only
        // carries the count at creation time, so seed it with the visible ids
        // we just added and hydrate the matching items' albumIds locally.
        const visibleCount = ids.filter((id) => {
          const item = get().items.find((i) => i.id === id);
          return item && !item.hidden;
        }).length;
        const created = { ...album, itemIds: ids, itemCount: visibleCount };
        const coverItems = ids
          .map((id) => get().items.find((item) => item.id === id))
          .filter(
            (item): item is MediaItem =>
              !!item &&
              !item.hidden &&
              (item.kind === "photo" || item.kind === "video"),
          )
          .slice(0, 4);
        set((s) => ({
          albums: [...s.albums, created],
          albumOverviews: [
            ...s.albumOverviews,
            {
              id: created.id,
              name: created.name,
              colorIndex: created.colorIndex,
              createdAt: created.createdAt,
              updatedAt: created.updatedAt,
              itemCount: visibleCount,
              coverItems,
            },
          ],
          items: s.items.map((item) =>
            ids.includes(item.id)
              ? {
                  ...item,
                  albumIds: Array.from(
                    new Set([...(item.albumIds || []), created.id]),
                  ),
                }
              : item,
          ),
          // An empty album created from the sidebar should not pull the user
          // out of the current view. Only jump into it when it contains the
          // selection that was used to create it.
          activeAlbum: ids.length ? created.id : s.activeAlbum,
          filter: ids.length ? "All" : s.filter,
        }));
        get().refreshDerived();
        get().showNotice(
          ids.length
            ? `Created album "${trimmed}" with ${ids.length} ${ids.length === 1 ? "item" : "items"}`
            : `Created album "${trimmed}"`,
        );
      },

      deleteAlbum: async (albumId) => {
        await tauri.albums.delete(albumId);
        // Deleting the container must never touch media items. Removing the
        // membership ids locally keeps cards, filters, and the inspector in
        // sync without a full library round-trip.
        set((s) => ({
          albums: s.albums.filter((a) => a.id !== albumId),
          albumOverviews: s.albumOverviews.filter((a) => a.id !== albumId),
          items: s.items.map((item) =>
            item.albumIds?.includes(albumId)
              ? {
                  ...item,
                  albumIds: item.albumIds.filter((id) => id !== albumId),
                }
              : item,
          ),
          activeAlbum: s.activeAlbum === albumId ? null : s.activeAlbum,
        }));
        get().refreshDerived();
      },

      renameAlbum: async (albumId, name) => {
        await tauri.albums.rename(albumId, name);
        set((s) => ({
          albums: s.albums.map((a) => (a.id === albumId ? { ...a, name } : a)),
          albumOverviews: s.albumOverviews.map((a) =>
            a.id === albumId ? { ...a, name } : a,
          ),
        }));
      },

      addToAlbum: async (albumId, itemIds = get().selectedIds) => {
        if (!itemIds.length) return;

        // Count only visible items that were not already in the album, so
        // repeated adds do not inflate the sidebar badge. Hidden items can be
        // filed into albums too, but they stay out of the visible count.
        const current = get();
        const newlyLinked = itemIds.filter((id) => {
          const item = current.items.find((i) => i.id === id);
          return item && !(item.albumIds || []).includes(albumId);
        });
        const newlyAdded = newlyLinked.filter((id) => {
          const item = current.items.find((i) => i.id === id);
          return item && !item.hidden;
        });

        await tauri.albums.addItems(albumId, itemIds);
        set((s) => ({
          items: s.items.map((item) =>
            itemIds.includes(item.id)
              ? {
                  ...item,
                  albumIds: Array.from(
                    new Set([...(item.albumIds || []), albumId]),
                  ),
                }
              : item,
          ),
          albums: s.albums.map((album) =>
            album.id === albumId
              ? {
                  ...album,
                  itemCount: (album.itemCount || 0) + newlyAdded.length,
                }
              : album,
          ),
          albumOverviews: s.albumOverviews.map((album) =>
            album.id === albumId
              ? {
                  ...album,
                  itemCount: (album.itemCount || 0) + newlyAdded.length,
                }
              : album,
          ),
        }));
        get().refreshDerived();
        const albumName = current.albums.find(
          (album) => album.id === albumId,
        )?.name;
        get().showNotice(
          newlyLinked.length
            ? `Added ${newlyLinked.length} ${newlyLinked.length === 1 ? "item" : "items"}${albumName ? ` to "${albumName}"` : ""}`
            : `Those photos are already${albumName ? ` in "${albumName}"` : " in that album"}.`,
        );
      },

      removeFromAlbum: async (albumId, itemIds) => {
        if (!itemIds.length) return;

        const current = get();
        const removedIds = itemIds.filter((id) => {
          const item = current.items.find((i) => i.id === id);
          return item && !item.hidden && item.albumIds?.includes(albumId);
        });

        await tauri.albums.removeItems(albumId, itemIds);
        set((s) => ({
          items: s.items.map((item) =>
            itemIds.includes(item.id)
              ? {
                  ...item,
                  albumIds: (item.albumIds || []).filter(
                    (id) => id !== albumId,
                  ),
                }
              : item,
          ),
          albums: s.albums.map((album) =>
            album.id === albumId
              ? {
                  ...album,
                  itemCount: Math.max(
                    0,
                    (album.itemCount || 0) - removedIds.length,
                  ),
                }
              : album,
          ),
          albumOverviews: s.albumOverviews.map((album) =>
            album.id === albumId
              ? {
                  ...album,
                  itemCount: Math.max(
                    0,
                    (album.itemCount || 0) - removedIds.length,
                  ),
                }
              : album,
          ),
          // Removed photos are no longer visible in the open album, so don't
          // leave ghost selection or an inspector pointing at an absent tile.
          selectedIds:
            s.activeAlbum === albumId
              ? s.selectedIds.filter((id) => !removedIds.includes(id))
              : s.selectedIds,
          inspectedId:
            s.activeAlbum === albumId &&
            s.inspectedId &&
            removedIds.includes(s.inspectedId)
              ? null
              : s.inspectedId,
        }));
        get().refreshDerived();
        const albumName = current.albums.find(
          (album) => album.id === albumId,
        )?.name;
        get().showNotice(
          `Removed ${removedIds.length} ${removedIds.length === 1 ? "item" : "items"}${albumName ? ` from "${albumName}"` : " from the album"}`,
        );
      },

      loadAlbumItems: async (albumId) => {
        const items = await tauri.albums.getItems(albumId);
        set((s) => ({
          albumItems: { ...s.albumItems, [albumId]: items },
        }));
      },

      // Smart Albums save the validated filter definition, not item ids, so
      // their membership follows metadata changes automatically.
      loadSmartAlbums: async () => {
        try {
          const smartAlbums = await tauri.smartAlbums.get();
          set({ smartAlbums });
        } catch (error) {
          get().showNotice(
            `Could not load Smart Albums: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },

      createSmartAlbum: async (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const state = get();
        const kind =
          state.filter === "Photos"
            ? "photo"
            : state.filter === "Videos"
              ? "video"
              : state.filter === "RAW"
                ? "raw"
                : undefined;
        const filter: SmartAlbumFilter = {
          kind,
          favorite:
            state.filter === "Favorites" ? true : undefined,
          query: state.query.trim() || undefined,
          dateFrom: state.dateFrom ?? undefined,
          dateTo: state.dateTo ?? undefined,
          sourcePath: state.activeSource ?? undefined,
          rating: state.minRating ?? undefined,
          colorLabel: state.colorLabelFilter ?? undefined,
          camera: state.cameraFilter ?? undefined,
          lens: state.lensFilter ?? undefined,
          sortBy: state.sortBy,
          sortOrder: state.sortOrder,
        };
        try {
          const album = await tauri.smartAlbums.create(trimmed, filter);
          set((s) => ({ smartAlbums: [...s.smartAlbums, album] }));
          get().showNotice(`Saved Smart Album "${album.name}".`);
        } catch (error) {
          get().showNotice(
            `Could not save Smart Album: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },

      renameSmartAlbum: async (albumId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        try {
          await tauri.smartAlbums.rename(albumId, trimmed);
          set((s) => ({
            smartAlbums: s.smartAlbums.map((album) =>
              album.id === albumId ? { ...album, name: trimmed } : album,
            ),
          }));
        } catch (error) {
          get().showNotice(
            `Could not rename Smart Album: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },

      deleteSmartAlbum: async (albumId) => {
        try {
          await tauri.smartAlbums.delete(albumId);
          set((s) => ({
            smartAlbums: s.smartAlbums.filter((album) => album.id !== albumId),
            activeSmartAlbum:
              s.activeSmartAlbum === albumId ? null : s.activeSmartAlbum,
          }));
          get().showNotice("Smart Album deleted. Photos were not changed.");
        } catch (error) {
          get().showNotice(
            `Could not delete Smart Album: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },

      openSmartAlbum: async (albumId) => {
        const album = get().smartAlbums.find((entry) => entry.id === albumId);
        if (!album) {
          get().showNotice("That Smart Album no longer exists.");
          return;
        }
        const filter = album.filter;
        const kindFilter: Filter =
          filter.favorite === true
            ? "Favorites"
            : filter.kind === "photo"
              ? "Photos"
              : filter.kind === "video"
                ? "Videos"
                : filter.kind === "raw"
                  ? "RAW"
                  : "All";
        set({
          activeAlbum: null,
          activeSmartAlbum: albumId,
          filter: kindFilter,
          query: filter.query ?? "",
          activeSource: filter.sourcePath ?? null,
          dateFrom: filter.dateFrom ?? null,
          dateTo: filter.dateTo ?? null,
          minRating: filter.rating ?? null,
          colorLabelFilter: filter.colorLabel ?? null,
          cameraFilter: filter.camera ?? null,
          lensFilter: filter.lens ?? null,
          sortBy: filter.sortBy ?? get().sortBy,
          sortOrder: filter.sortOrder ?? get().sortOrder,
        });
        get().refreshDerived();
        await get().loadLibrary();
      },

      // Duplicates
      scanDuplicates: async () => {
        // Keep previous results so we can merge partial results on cancel
        const previousDuplicates = get().duplicates;
        set({
          busy: true,
          canceling: false,
          progress: { phase: "hashing", processed: 0, total: 0 },
        });
        try {
          const duplicates = await tauri.duplicates.scan();
          const cancelled = get().canceling;
          // On cancel, use partial results from this run (already saved to DB).
          // Merge with previous to preserve groups that were fully resolved.
          const merged = cancelled
            ? mergeDuplicateGroups(previousDuplicates, duplicates)
            : duplicates;
          set({
            duplicates: merged,
            busy: false,
            canceling: false,
            progress: null,
          });
          get().showNotice(
            cancelled
              ? `Duplicate scan cancelled. ${merged.length} group${merged.length === 1 ? "" : "s"} shown; completed hashes saved.`
              : duplicates.length
                ? `Found ${duplicates.length} duplicate groups`
                : "No duplicates found",
          );
        } catch (e) {
          const cancelled = get().canceling;
          set({
            busy: false,
            canceling: false,
            progress: null,
            notice: cancelled
              ? "Duplicate scan cancelled."
              : "Duplicate scan failed",
          });
        }
      },

      cancelScan: async () => {
        set({ canceling: true });
        try {
          await tauri.library.cancelScan();
        } catch (e) {
          set({
            canceling: false,
            notice: `Could not cancel scan: ${String(e)}`,
          });
        } finally {
          // Always clear canceling state - the backend flag is handled by next scan
          set({ canceling: false });
        }
      },

      clearDuplicates: () => set({ duplicates: [] }),

      // UI
      setBusy: (busy) => set({ busy, ...(busy ? {} : { canceling: false }) }),
      setProgress: (progress) => set({ progress }),
      showNotice: (text) => {
        set({ notice: text });
        if (text) {
          const warning =
            /failed|could not|cannot access|not a folder|could not read|no media files found|no supported media/i.test(
              text,
            );
          setTimeout(() => set({ notice: "" }), warning ? 8000 : 3600);
        }
      },

      // Internal: refresh derived state
      refreshDerived: () => {
        const derived = computeDerived(get());
        set(derived);
      },
    }),
    { name: "library-store" },
  ),
);

// Selectors
export const useVisibleItems = () => useLibraryStore((s) => s.visibleItems);
export const useInspectedItem = () =>
  useLibraryStore((s) => s.items.find((i) => i.id === s.inspectedId) || null);
export const useSelectedItems = () =>
  useLibraryStore(
    (s) =>
      s.selectedIds
        .map((id) => s.items.find((i) => i.id === id))
        .filter(Boolean) as MediaItem[],
  );
export const useSelectionCount = () =>
  useLibraryStore((s) => s.selectedIds.length);
// Backwards-compatible alias: the "selected item" is the inspected one.
export const useSelectedItem = useInspectedItem;
export const useFilter = () => useLibraryStore((s) => s.filter);
export const useQuery = () => useLibraryStore((s) => s.query);
export const useLayout = () => useLibraryStore((s) => s.layout);
export const useShowInspector = () => useLibraryStore((s) => s.showInspector);
export const useActiveAlbum = () => useLibraryStore((s) => s.activeAlbum);
export const useMinRating = () => useLibraryStore((s) => s.minRating);
export const useColorLabelFilter = () => useLibraryStore((s) => s.colorLabelFilter);
export const useCameraFilter = () => useLibraryStore((s) => s.cameraFilter);
export const useLensFilter = () => useLibraryStore((s) => s.lensFilter);
export const useDateFrom = () => useLibraryStore((s) => s.dateFrom);
export const useDateTo = () => useLibraryStore((s) => s.dateTo);
export const useAlbums = () => useLibraryStore((s) => s.albums);
export const useAlbumOverviews = () => useLibraryStore((s) => s.albumOverviews);
export const useSmartAlbums = () => useLibraryStore((s) => s.smartAlbums);
export const useActiveSmartAlbum = () =>
  useLibraryStore((s) => s.activeSmartAlbum);
export const useDuplicates = () => useLibraryStore((s) => s.duplicates);
export const useBusy = () => useLibraryStore((s) => s.busy);
export const useLibraryRefreshing = () =>
  useLibraryStore((s) => s.refreshingLibrary);
export const useProgress = () => useLibraryStore((s) => s.progress);
export const useNotice = () => useLibraryStore((s) => s.notice);
