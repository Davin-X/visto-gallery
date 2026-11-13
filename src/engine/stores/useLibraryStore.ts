import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
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
  DeleteItemsOutcome,
  LibraryFolder,
  LibraryFilterDTO,
  LibraryItemsPage,
  SmartAlbum,
  SmartAlbumFilter,
  ErrorCode,
} from "../types/commands";
import { describeError } from "../../app/utils/describeError";
import { errorCode } from "../types/errors";
import { tauri } from "../commands/tauri";
import { formatBytes } from "../commands/tauri";

/** Mirror the server's `ORDER BY name COLLATE NOCASE` so a newly created or
 *  renamed album lands where a reload would put it. */
function sortSmartAlbums(albums: SmartAlbum[]): SmartAlbum[] {
  return [...albums].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

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
  return [...byHash.values()].sort((a, b) => b.items.length - a.items.length || b.size - a.size);
}

export interface LibraryState {
  // Data
  items: MediaItem[];
  albums: Album[];
  albumOverviews: AlbumOverview[];
  smartAlbums: SmartAlbum[];
  tags: Tag[];
  duplicates: DuplicateGroup[];
  /** True once a duplicate scan has finished (or been cancelled) this
   *  session. Until then the screen must not claim there are no duplicates. */
  duplicatesScanned: boolean;
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
  // Rail mode collapses the sidebar to icons while it stays visible.
  // Distinct from `sidebarOpen`, which hides the sidebar entirely.
  sidebarCollapsed: boolean;
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
  /**
   * Filter/sort signature of the query that produced `items`. Screens use it
   * to tell when a view's first page has arrived before restoring its scroll
   * position, so a filter switch cannot restore an offset against stale rows.
   */
  loadedViewKey: string | null;
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
  /** Code behind `notice` when it came from a failed command. */
  noticeCode: ErrorCode | null;
  /** Optional action rendered inside the notice toast (e.g. "Undo"). */
  noticeAction: { label: string; run: () => void } | null;

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
  // Hidden gallery pagination state. The hidden set is small, but
  // unbounded `SELECT *` on a huge hidden folder is not free.
  hiddenCursor: string | null;
  hiddenHasMore: boolean;
  hiddenLoading: boolean;
  // Per-album item cache (all items in an album, not paginated)
  albumItems: Record<string, MediaItem[]>;
  // Actions - Data Loading
  loadLibrary: (filter?: LibraryFilter) => Promise<void>;
  loadItemsPage: (filter?: LibraryFilter) => Promise<void>;
  loadCatalogMetadata: () => Promise<void>;
  loadHiddenItems: () => Promise<void>;
  loadMoreHiddenItems: () => Promise<void>;
  loadNextPage: () => Promise<void>;
  loadFolders: () => Promise<void>;
  removeFolder: (path: string, deleteFiles?: boolean) => Promise<number>;
  importFolder: () => Promise<void>;
  importFiles: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshDerived: () => void;
  navigatePhoto: (delta: number) => void;
  navigateViewerPhoto: (delta: number) => Promise<boolean>;

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
  setSort: (sortBy: LibraryState["sortBy"], sortOrder: LibraryState["sortOrder"]) => void;
  setScreen: (screen: Screen) => void;
  setViewerScope: (scope: "library" | "hidden") => void;
  getCurrentLibraryFilter: () => LibraryFilterDTO;
  toggleInspector: () => void;
  toggleSidebar: () => void;
  toggleSidebarCollapsed: () => void;
  setActiveAlbum: (albumId: string | null) => void;

  // Actions - Items
  toggleFavorite: (id: string) => Promise<void>;
  toggleHidden: (id: string) => Promise<void>;
  setFavoriteForIds: (ids: string[], favorite: boolean) => Promise<void>;
  setHiddenForIds: (ids: string[], hidden: boolean) => Promise<void>;
  setRating: (id: string, rating: number) => Promise<void>;
  setColorLabel: (id: string, colorLabel: string | null) => Promise<void>;
  setRatingForIds: (ids: string[], rating: number) => Promise<void>;
  setColorLabelForIds: (ids: string[], colorLabel: string | null) => Promise<void>;
  updateItemTags: (id: string, tags: string[]) => Promise<void>;
  deleteItems: (ids: string[]) => Promise<DeleteItemsOutcome>;

  cancelDelete: () => Promise<void>;

  // Actions - Albums
  createAlbum: (name: string, itemIds?: string[]) => Promise<void>;
  deleteAlbum: (albumId: string) => Promise<void>;
  renameAlbum: (albumId: string, name: string) => Promise<void>;
  /** Persist the complete ordered album id list; albums are reordered
   *  optimistically and reverted on failure. */
  reorderAlbums: (albumIds: string[]) => Promise<boolean>;
  addToAlbum: (albumId: string, itemIds?: string[]) => Promise<void>;
  removeFromAlbum: (albumId: string, itemIds: string[]) => Promise<void>;
  loadAlbumItems: (albumId: string) => Promise<void>;

  // Actions - Smart Albums
  loadSmartAlbums: () => Promise<void>;
  createSmartAlbum: (name: string) => Promise<void>;
  createSmartAlbumFrom: (name: string, filter: SmartAlbumFilter) => Promise<boolean>;
  updateSmartAlbum: (albumId: string, name: string, filter: SmartAlbumFilter) => Promise<boolean>;
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
  showNotice: (
    text: string,
    code?: ErrorCode | null,
    action?: { label: string; run: () => void },
  ) => void;
  /** Show a failed command's message, with its code for the toast tone. */
  showErrorNotice: (error: unknown, prefix?: string) => void;
}

/** Map the hidden view's UI filter onto the backend page query, so filtering
 * happens in SQL rather than over whatever subset happened to be loaded. */
function hiddenPageFilter(state: {
  hiddenFilter: Filter;
  hiddenQuery: string;
  sortBy: LibraryState["sortBy"];
  sortOrder: LibraryState["sortOrder"];
}): {
  kind?: "photo" | "video" | "raw";
  animated?: boolean;
  favorite?: boolean;
  hidden?: true;
  query?: string;
  sortBy: LibraryState["sortBy"];
  sortOrder: LibraryState["sortOrder"];
} {
  const filter = state.hiddenFilter;
  const base = {
    hidden: true as const,
    query: state.hiddenQuery.trim() || undefined,
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
  };
  if (filter === "Photos") return { ...base, kind: "photo" };
  if (filter === "Videos") return { ...base, kind: "video" };
  if (filter === "RAW") return { ...base, kind: "raw" };
  if (filter === "Animations") return { ...base, animated: true };
  if (filter === "Favorites") return { ...base, favorite: true };
  return base;
}

// Load generation and query debounce are per-app (not per-store-instance).
let libraryLoadGeneration = 0;
// Request tickets for paged loads. A filter reload resets `loadingNextPage`,
// so a continuation request that was already in flight when that happened
// could finish later and clear the flag a newer request had just set — which
// lets the same cursor be fetched twice. A response may only touch shared
// paging state while it is still the newest request of its kind.
let nextPageRequestId = 0;
let nextHiddenRequestId = 0;
let hiddenQueryReloadTimer: ReturnType<typeof setTimeout> | null = null;
let queryReloadTimer: ReturnType<typeof setTimeout> | null = null;
// Debounce for free-text camera/lens filters so typing doesn't reload the
// library on every keystroke. State updates stay immediate; only the IPC
// round-trip is deferred.
let cameraLensReloadTimer: ReturnType<typeof setTimeout> | null = null;

const HIDDEN_PAGE_SIZE = 250;

// Normalize a paged command's return value: older callers returned a bare
// array, newer ones return { items, hasMore, nextCursor, totalCount? }.
function normalizePageResult(result: LibraryItemsPage | MediaItem[] | unknown): LibraryItemsPage {
  if (Array.isArray(result)) {
    return {
      items: result as MediaItem[],
      hasMore: false,
      totalCount: (result as MediaItem[]).length,
    };
  }
  return result as LibraryItemsPage;
}

// in-flight guard for "select everything matching" — the IPC can return tens
// of thousands of ids; avoid re-triggering while one is still running.
let selectAllMatchingInFlight = false;

// Select everything that matches the current filter, without paging in the
// visible window. Previously this selected only whichever items were already
// rendered, so a big search result gave you 250 instead of everything.
function selectAllMatching() {
  if (selectAllMatchingInFlight) return;
  selectAllMatchingInFlight = true;
  const state = useLibraryStore.getState();
  tauri.library
    .getMatchingIds(currentLibraryFilter(state))
    .then((ids) => {
      useLibraryStore.setState({ selectedIds: ids });
      useLibraryStore
        .getState()
        .showNotice(`Selected all ${ids.length.toLocaleString()} matching items.`);
    })
    .catch((error) => {
      if (import.meta.env.DEV) console.error("Select all failed:", error);
      useLibraryStore.getState().showErrorNotice(error, "Could not select all matching items");
    })
    .finally(() => {
      selectAllMatchingInFlight = false;
    });
}

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
    // "Animations" is a property of the item, not a kind: GIFs stay photos so
    // the Photos count, viewer and edit flows keep working unchanged.
    animated: state.filter === "Animations" ? true : state.filter === "Photos" ? false : undefined,
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
    hidden: false,
  };
}

/**
 * Stable signature of the filter/sort state that produces `items`.
 *
 * LibraryScreen keys its scroll memory with this value and the store records
 * it on every successful page load. Keeping both sides on the same helper
 * means a tab switch can never restore an offset against a different query.
 */
export function libraryViewKey(state: LibraryState): string {
  return JSON.stringify(currentLibraryFilter(state));
}

function findKnownItem(state: LibraryState, id: string): MediaItem | null {
  const direct =
    state.items.find((item) => item.id === id) || state.hiddenItems.find((item) => item.id === id);
  if (direct) return direct;
  for (const group of state.duplicates) {
    const match = group.items.find((item) => item.id === id);
    if (match) return match;
  }
  return null;
}

function resolveInspectedItem(state: LibraryState, viewerItems: MediaItem[]) {
  if (state.inspectedId) {
    return (
      viewerItems.find((item) => item.id === state.inspectedId) ||
      findKnownItem(state, state.inspectedId) ||
      null
    );
  }
  return viewerItems[0] || null;
}

function computeInspectionDerived(state: LibraryState) {
  const viewerSelected = resolveInspectedItem(state, state.viewerItems);
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
  const { items, filter, query, activeAlbum, activeSource, inspectedId, viewerScope } = state;

  // Items arrive from the backend already filtered and ordered (sort column
  // is whitelisted server-side with an `id` tie-break). Re-sorting here
  // used to reshuffle keyset page boundaries because the two collations
  // disagreed for `IMG_10` vs `IMG_2`; the order the backend chose is the
  // order the grid renders.
  let visible = items;

  visible = visible.filter((item) => {
    if (filter === "Photos" && (item.kind !== "photo" || item.isAnimated)) return false;
    if (filter === "Videos" && item.kind !== "video") return false;
    if (filter === "RAW" && item.kind !== "raw") return false;
    if (filter === "Animations" && !item.isAnimated) return false;
    if (filter === "Favorites" && !item.favorite) return false;
    return true;
  });

  if (activeAlbum) {
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

  if (activeSource) {
    const prefix = activeSource.endsWith("/") ? activeSource : `${activeSource}/`;
    visible = visible.filter((item) => item.path === activeSource || item.path.startsWith(prefix));
  }

  const playable = visible.filter((item) => item.kind === "photo" || item.kind === "video");

  const matchesKindFilter = (item: MediaItem, f: Filter) => {
    if (f === "Photos" && (item.kind !== "photo" || item.isAnimated)) return false;
    if (f === "Videos" && item.kind !== "video") return false;
    if (f === "RAW" && item.kind !== "raw") return false;
    if (f === "Animations" && !item.isAnimated) return false;
    if (f === "Favorites" && !item.favorite) return false;
    return true;
  };

  let viewerItems: MediaItem[];
  if (viewerScope === "hidden") {
    const q = (state.hiddenQuery || "").trim().toLowerCase();
    viewerItems = (state.hiddenItems || []).filter((item) => {
      if (!matchesKindFilter(item, state.hiddenFilter || "All")) return false;
      if (q) {
        const hay = `${item.name || ""} ${item.path || ""} ${item.extension || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  } else {
    // Hidden items are excluded by the hidden=false filter sent to the
    // backend, so viewerItems always comes from the visible set.
    viewerItems = visible.filter((item) => matchesKindFilter(item, state.filter));
  }

  const viewerSelected = resolveInspectedItem({ ...state, inspectedId }, viewerItems);
  const currentIndex = Math.max(
    0,
    playable.findIndex((item) => item.id === inspectedId),
  );
  const viewerIndex = viewerSelected
    ? viewerItems.findIndex((item) => item.id === viewerSelected.id)
    : -1;

  return {
    visibleItems: visible,
    sortedItems: items,
    playableItems: playable,
    viewerItems,
    viewerSelected,
    currentIndex,
    viewerIndex,
    hiddenItems: state.hiddenItems,
    hiddenCount: state.hiddenItems.length,
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
      duplicatesScanned: false,
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
      sidebarCollapsed: false,
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
      noticeCode: null,
      noticeAction: null,

      // Pagination
      page: 0,
      pageSize: 250,
      hasMore: false,
      nextCursor: null,
      totalCount: 0,
      loadingNextPage: false,
      loadedViewKey: null,

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
      hiddenCursor: null,
      hiddenHasMore: false,
      hiddenLoading: false,

      // Per-album item cache (all items in an album, not paginated)
      albumItems: {},
      // Data Loading
      // Load only library items (paged). Called frequently when filters change.
      // Catalog metadata (albums, smart albums, tags, folders) is NOT refreshed
      // here — call loadCatalogMetadata() for that.
      loadItemsPage: async (filter?: LibraryFilter) => {
        const generation = ++libraryLoadGeneration;
        set({
          refreshingLibrary: true,
          page: 0,
          hasMore: false,
          nextCursor: null,
          loadingNextPage: false,
        });
        try {
          const state = get();
          const viewFilter = { ...currentLibraryFilter(state), ...(filter || {}) };
          const normalizedColorLabel = viewFilter.colorLabel ?? undefined;
          viewFilter.colorLabel = normalizedColorLabel;
          const viewKey = JSON.stringify(viewFilter);
          const dto: LibraryFilterDTO = {
            ...viewFilter,
            colorLabel: normalizedColorLabel,
            limit: state.pageSize,
            cursor: undefined,
          };

          const isTauri =
            typeof window !== "undefined" &&
            ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
          if (!isTauri) {
            if (import.meta.env.DEV)
              console.warn("Tauri IPC is not available in browser preview mode.");
            set({ refreshingLibrary: false, loadedViewKey: viewKey });
            get().refreshDerived();
            return;
          }

          const pageResult = await tauri.library.getItems(dto);
          if (generation !== libraryLoadGeneration) return;
          const page = normalizePageResult(pageResult);

          set({
            items: page.items,
            refreshingLibrary: false,
            page: 0,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor ?? null,
            totalCount: page.totalCount ?? 0,
            loadedViewKey: viewKey,
          });
          get().refreshDerived();
        } catch (e) {
          if (generation !== libraryLoadGeneration) return;
          if (import.meta.env.DEV) console.error("loadItemsPage failed:", e);
          set({ refreshingLibrary: false, loadedViewKey: null });
          get().showErrorNotice(e, "Failed to load library");
        }
      },

      // Load catalog metadata (albums, smart albums, tags, folders). Called
      // infrequently when sources or albums change — not on every filter
      // change.
      loadCatalogMetadata: async () => {
        const generation = ++libraryLoadGeneration;
        // Each list loads on its own: one failing command (say, a Smart Album
        // the backend cannot evaluate) must not blank albums, tags and
        // folders that loaded fine. Lists that fail keep their last value.
        const [albumOverviews, smartAlbums, tags, folders] = await Promise.allSettled([
          tauri.albums.getOverviews(),
          tauri.smartAlbums.get(),
          tauri.albums.getTags(),
          tauri.library.getFolders(),
        ]);
        if (generation !== libraryLoadGeneration) return;
        const update: Partial<LibraryState> = {};
        if (albumOverviews.status === "fulfilled") {
          update.albumOverviews = albumOverviews.value;
          update.albums = albumOverviews.value.map((album) => ({
            id: album.id,
            name: album.name,
            colorIndex: album.colorIndex,
            itemCount: album.itemCount,
            itemSize: album.itemSize,
            itemIds: [],
            createdAt: album.createdAt,
            updatedAt: album.updatedAt,
          }));
        }
        if (smartAlbums.status === "fulfilled") update.smartAlbums = smartAlbums.value;
        if (tags.status === "fulfilled") update.tags = tags.value;
        if (folders.status === "fulfilled") update.folders = folders.value;
        set(update);
        get().refreshDerived();

        const failures = [
          ["albums", albumOverviews],
          ["Smart Albums", smartAlbums],
          ["tags", tags],
          ["sources", folders],
        ].filter(([, result]) => (result as PromiseSettledResult<unknown>).status === "rejected");
        if (failures.length > 0) {
          const first = failures[0][1] as PromiseRejectedResult;
          if (import.meta.env.DEV) console.error("loadCatalogMetadata failed:", failures);
          get().showErrorNotice(
            first.reason,
            `Could not load ${failures.map(([label]) => label).join(", ")}`,
          );
        }
      },

      // Load both items (paged) and catalog metadata. Used on first load or
      // when both need refreshing. For filter-only changes, prefer
      // loadItemsPage().
      loadLibrary: async (filter?: LibraryFilter) => {
        await get().loadItemsPage(filter);
        await get().loadCatalogMetadata();
        await get().loadHiddenItems();
        get().refreshDerived();
      },

      // Load hidden items separately since the main items query always
      // filters hidden = false. These power the Hidden screen. First page
      // here, continuation pages via loadMoreHiddenItems.
      loadHiddenItems: async () => {
        const generation = libraryLoadGeneration;
        const requestId = ++nextHiddenRequestId;
        const isCurrent = () =>
          generation === libraryLoadGeneration && requestId === nextHiddenRequestId;
        const releaseIfOwner = () => {
          if (requestId === nextHiddenRequestId) set({ hiddenLoading: false });
        };
        const isTauri =
          typeof window !== "undefined" &&
          ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
        if (!isTauri) {
          set({ hiddenItems: [], hiddenCount: 0, hiddenCursor: null, hiddenHasMore: false });
          return;
        }
        try {
          set({ hiddenLoading: true });
          const pageResult = await tauri.library.getHiddenItems({
            limit: HIDDEN_PAGE_SIZE,
            ...hiddenPageFilter(get()),
          });
          if (!isCurrent()) {
            releaseIfOwner();
            return;
          }
          const page = normalizePageResult(pageResult);
          set({
            hiddenItems: page.items,
            hiddenCount: page.totalCount ?? page.items.length,
            hiddenCursor: page.nextCursor ?? null,
            hiddenHasMore: page.hasMore,
            hiddenLoading: false,
          });
        } catch (e) {
          if (!isCurrent()) {
            releaseIfOwner();
            return;
          }
          if (import.meta.env.DEV) console.error("loadHiddenItems failed:", e);
          set({
            hiddenItems: [],
            hiddenCount: 0,
            hiddenCursor: null,
            hiddenHasMore: false,
            hiddenLoading: false,
          });
        }
      },

      loadMoreHiddenItems: async () => {
        const state = get();
        if (state.hiddenLoading || !state.hiddenHasMore) return;
        const cursor = state.hiddenCursor;
        if (!cursor) return;
        const generation = libraryLoadGeneration;
        const requestId = ++nextHiddenRequestId;
        set({ hiddenLoading: true });
        try {
          const pageResult = await tauri.library.getHiddenItems({
            limit: HIDDEN_PAGE_SIZE,
            cursor,
            ...hiddenPageFilter(get()),
          });
          if (generation !== libraryLoadGeneration || requestId !== nextHiddenRequestId) {
            // A newer hidden request owns the list and the loading flag.
            if (requestId === nextHiddenRequestId) set({ hiddenLoading: false });
            return;
          }
          const page = normalizePageResult(pageResult);
          set((current) => {
            const known = new Set(current.hiddenItems.map((item) => item.id));
            const additions = page.items.filter((item) => !known.has(item.id));
            return {
              hiddenItems: [...current.hiddenItems, ...additions],
              hiddenCursor: page.nextCursor ?? null,
              hiddenHasMore: page.hasMore,
              hiddenCount: page.totalCount ?? current.hiddenCount,
              hiddenLoading: false,
            };
          });
        } catch (error) {
          if (requestId === nextHiddenRequestId) set({ hiddenLoading: false });
          if (generation !== libraryLoadGeneration || requestId !== nextHiddenRequestId) return;
          get().showErrorNotice(error, "Failed to load more hidden items");
        }
      },

      loadNextPage: async () => {
        const state = get();
        // M3: the guard on `loadingNextPage` and `generation` used to be
        // missing for the synchronous re-entry path, so a slow continuation
        // request could start a duplicate fetch of the same cursor.
        if (state.busy || state.loadingNextPage || !state.hasMore || !state.nextCursor) return;
        const cursor = state.nextCursor;
        const generation = libraryLoadGeneration;
        const requestId = ++nextPageRequestId;
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
          if (generation !== libraryLoadGeneration || requestId !== nextPageRequestId) {
            // A filter/sort reload superseded this continuation request. Do
            // not leave the quiet paging guard stuck on if the old request
            // happens to finish after the replacement load, and do not clear
            // it when a newer page request now owns it.
            if (requestId === nextPageRequestId) set({ loadingNextPage: false });
            return;
          }
          const page = normalizePageResult(pageResult);
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
          if (requestId === nextPageRequestId) set({ loadingNextPage: false });
          if (generation !== libraryLoadGeneration || requestId !== nextPageRequestId) return;
          get().showErrorNotice(error, "Failed to load more items");
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
            .items.filter((item) => item.path === path || item.path.startsWith(prefix))
            .map((item) => item.id),
        );

        set((s) => ({
          items: s.items.filter((item) => !removedIds.has(item.id)),
          selectedIds: s.selectedIds.filter((id) => !removedIds.has(id)),
          // Never leave inspection pointing at an item that no longer exists.
          inspectedId: s.inspectedId && removedIds.has(s.inspectedId) ? null : s.inspectedId,
          folders: s.folders.filter((folder) => folder.path !== path),
          // Drop a source filter that pointed into the removed folder.
          activeSource:
            s.activeSource === path || (s.activeSource && s.activeSource.startsWith(prefix))
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
        if (id !== null && !findKnownItem(state, id)) return;
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
        const nextIndex = (currentIndex + delta + playableItems.length) % playableItems.length;
        const state = get();
        const inspectedId = playableItems[nextIndex].id;
        set({
          inspectedId,
          ...computeInspectionDerived({ ...state, inspectedId }),
        });
      },

      navigateViewerPhoto: async (delta) => {
        let state = get();
        const currentId = state.viewerSelected?.id;
        if (!currentId || delta === 0) return false;

        let photos = state.viewerItems.filter((item) => item.kind !== "video");
        let currentIndex = photos.findIndex((item) => item.id === currentId);
        if (currentIndex < 0) return false;

        if (delta > 0 && state.viewerScope === "library" && currentIndex + delta >= photos.length) {
          while (state.hasMore) {
            const previousItemCount = state.items.length;
            await state.loadNextPage();
            state = get();
            if (state.items.length === previousItemCount && state.hasMore) return false;

            photos = state.viewerItems.filter((item) => item.kind !== "video");
            currentIndex = photos.findIndex((item) => item.id === currentId);
            if (currentIndex < 0) return false;
            if (currentIndex + delta < photos.length) break;
          }
        }

        const nextIndex = (currentIndex + delta + photos.length) % photos.length;
        const inspectedId = photos[nextIndex].id;
        state = get();
        set({
          inspectedId,
          ...computeInspectionDerived({ ...state, inspectedId }),
        });
        return true;
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
        const state = get();
        // "Everything matching" scales with the whole query result; the visible
        // set is not a fair proxy. When more pages exist on the server, fetch
        // every matching id instead of only the loaded window.
        const universe = state.hasMore ? state.totalCount : state.visibleItems.length;
        if (universe > 0 && state.selectedIds.length >= universe) {
          set({ selectedIds: [] });
          return;
        }
        if (state.hasMore) {
          selectAllMatching();
          return;
        }
        set({ selectedIds: state.visibleItems.map((item) => item.id) });
      },

      selectAll: () => {
        const state = get();
        if (state.hasMore) {
          selectAllMatching();
          return;
        }
        set({ selectedIds: state.visibleItems.map((item) => item.id) });
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

      clearHiddenFilters: () => {
        set({ hiddenFilter: "All", hiddenQuery: "" });
        void get().loadHiddenItems();
      },

      setHiddenFilter: (hiddenFilter) => {
        set({ hiddenFilter });
        void get().loadHiddenItems();
      },

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

      setHiddenQuery: (hiddenQuery) => {
        set({ hiddenQuery });
        if (hiddenQueryReloadTimer) clearTimeout(hiddenQueryReloadTimer);
        hiddenQueryReloadTimer = setTimeout(() => {
          hiddenQueryReloadTimer = null;
          void get().loadHiddenItems();
        }, 180);
      },

      setLayout: (layout) => set({ layout }),

      setSort: (sortBy, sortOrder) => {
        set({ sortBy, sortOrder });
        get().refreshDerived();
        if (get().screen === "Hidden") void get().loadHiddenItems();
        else void get().loadLibrary();
      },

      setScreen: (screen) => set({ screen }),

      setViewerScope: (viewerScope) => {
        if (get().viewerScope === viewerScope) return;
        set({ viewerScope });
        get().refreshDerived();
      },

      getCurrentLibraryFilter: () => currentLibraryFilter(get()),
      toggleInspector: () => set((s) => ({ showInspector: !s.showInspector })),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

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
          items: s.items.map((i) => (i.id === id ? { ...i, favorite: next } : i)),
        }));
        get().refreshDerived();
      },

      setFavoriteForIds: async (ids, favorite) => {
        const targets = get().items.filter((i) => ids.includes(i.id));
        await Promise.all(targets.map((i) => tauri.items.toggleFavorite(i.id, favorite)));
        set((s) => ({
          items: s.items.map((i) => (ids.includes(i.id) ? { ...i, favorite } : i)),
        }));
        get().refreshDerived();
      },

      setHiddenForIds: async (ids, hidden) => {
        if (!ids.length) return;
        // Targets may live in the normal library or in the hidden collection
        // (Hidden screen). Resolve from both so bulk unhide works there.
        const state = get();
        const pool = [...state.items, ...state.hiddenItems];
        const seen = new Set<string>();
        const targets = pool.filter((i) => {
          if (!ids.includes(i.id) || seen.has(i.id)) return false;
          seen.add(i.id);
          return true;
        });
        if (!targets.length) return;

        // Hiding removes an item from every visible collection; unhiding puts
        // it back. Album counts only describe visible items, so keep them in
        // step locally instead of waiting for a reload.
        const hiding = hidden ? targets.filter((i) => !i.hidden) : [];
        const showing = hidden ? [] : targets.filter((i) => i.hidden);

        await Promise.all(targets.map((i) => tauri.items.toggleHidden(i.id, hidden)));

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

        set((s) => {
          const idSet = new Set(ids);
          const nextHiddenItems = hidden
            ? [
                ...s.hiddenItems.filter((i) => !idSet.has(i.id)),
                ...targets
                  .filter((i) => !s.hiddenItems.some((h) => h.id === i.id))
                  .map((i) => ({ ...i, hidden: true })),
              ]
            : s.hiddenItems.filter((i) => !idSet.has(i.id));
          return {
            // Hiding removes items from the visible library; unhiding clears the
            // flag for any copy still present in items.
            items: hidden
              ? s.items.filter((i) => !idSet.has(i.id))
              : s.items.map((i) => (idSet.has(i.id) ? { ...i, hidden } : i)),
            hiddenItems: nextHiddenItems,
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
            selectedIds: s.selectedIds.filter((id) => !idSet.has(id)),
            inspectedId: s.inspectedId && idSet.has(s.inspectedId) ? null : s.inspectedId,
            duplicates: s.duplicates.map((g) => ({
              ...g,
              items: g.items.map((i) => (idSet.has(i.id) ? { ...i, hidden } : i)),
            })),
          };
        });
        get().refreshDerived();
        // Keep both collections authoritative: hidden view reflects changes
        // immediately after optimistic update, and unhiding restores items to
        // the filtered library page.
        void get().loadHiddenItems();
        if (!hidden) void get().loadItemsPage();
      },

      toggleHidden: async (id) => {
        const item =
          get().items.find((i) => i.id === id) ?? get().hiddenItems.find((i) => i.id === id);
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
          items: s.items.map((i) => (i.id === id ? { ...i, colorLabel: colorLabel || null } : i)),
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
        const prevs = new Map(targets.map((i) => [i.id, { ...i }]));
        set((s) => ({
          items: s.items.map((i) => (ids.includes(i.id) ? { ...i, rating } : i)),
        }));
        get().refreshDerived();
        try {
          await Promise.all(targets.map((i) => tauri.items.setRating(i.id, rating)));
        } catch (error) {
          console.error(`Failed to set rating for ${ids.length} items:`, error);
          set((s) => ({
            items: s.items.map((i) => (ids.includes(i.id) ? { ...prevs.get(i.id)! } : i)),
          }));
          get().refreshDerived();
        }
      },

      setColorLabelForIds: async (ids, colorLabel) => {
        const targets = get().items.filter((i) => ids.includes(i.id));
        if (!targets.length) return;
        const prevs = new Map(targets.map((i) => [i.id, { ...i }]));
        set((s) => ({
          items: s.items.map((i) =>
            ids.includes(i.id) ? { ...i, colorLabel: colorLabel || null } : i,
          ),
        }));
        get().refreshDerived();
        try {
          await Promise.all(targets.map((i) => tauri.items.setColorLabel(i.id, colorLabel)));
        } catch (error) {
          console.error(`Failed to set color label for ${ids.length} items:`, error);
          set((s) => ({
            items: s.items.map((i) => (ids.includes(i.id) ? { ...prevs.get(i.id)! } : i)),
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
        // The backend resolves catalog ids to paths itself, so this works for
        // duplicates and hidden items that are outside the loaded library
        // page. Sending paths from renderer state silently missed those.
        const uniqueIds = [...new Set(ids)].filter(Boolean);
        if (uniqueIds.length === 0) {
          return { status: "done", trashed: 0, failed: 0, bytes: 0, failures: [] };
        }
        // Sizes have to be read before the rows are dropped, and duplicates /
        // hidden items can reference rows outside the loaded library page.
        const sizeById = new Map<string, number>();
        const state = get();
        const rememberSize = (item: { id: string; size: number }) => {
          if (!sizeById.has(item.id)) sizeById.set(item.id, item.size);
        };
        state.items.forEach(rememberSize);
        state.hiddenItems.forEach(rememberSize);
        state.duplicates.forEach((group) => group.items.forEach(rememberSize));
        const bytesFor = (trashed: Set<string>) => {
          let total = 0;
          trashed.forEach((id) => {
            total += sizeById.get(id) ?? 0;
          });
          return total;
        };
        set({
          busy: true,
          canceling: false,
          progress: { phase: "trashing", processed: 0, total: uniqueIds.length },
        });
        try {
          const result = await tauri.items.moveToTrash(uniqueIds);
          // Only remove items the backend confirms it moved to Trash.
          const trashedIds = new Set(result.trashed);
          set({ busy: false, canceling: false, progress: null });
          set((s) => {
            const remainingHidden = s.hiddenItems.filter((i) => !trashedIds.has(i.id));
            // Hidden rows were never part of the library total, so subtracting
            // every trashed id over-counted the removal (and left the footer
            // short whenever the delete came from the hidden screen).
            const hiddenTrashed = s.hiddenItems.filter((i) => trashedIds.has(i.id)).length;
            const libraryTrashed = trashedIds.size - hiddenTrashed;
            return {
              items: s.items.filter((i) => !trashedIds.has(i.id)),
              hiddenItems: remainingHidden,
              hiddenCount: Math.max(0, s.hiddenCount - hiddenTrashed),
              selectedIds: s.selectedIds.filter((id) => !trashedIds.has(id)),
              totalCount: Math.max(0, s.totalCount - libraryTrashed),
              inspectedId: s.inspectedId && trashedIds.has(s.inspectedId) ? null : s.inspectedId,
              duplicates: s.duplicates
                .map((g) => ({
                  ...g,
                  items: g.items.filter((i) => !trashedIds.has(i.id)),
                }))
                .filter((g) => (g.items?.length || 0) > 1),
            };
          });
          get().refreshDerived();
          // A cancel is only a cancel when nothing moved; a partial stop is a
          // real (smaller) delete and the caller should say so.
          const cancelled =
            trashedIds.size === 0 &&
            result.failed.length > 0 &&
            result.failed.every((f) => f.code === "cancelled");
          if (cancelled) {
            return { status: "cancelled", trashed: 0, failed: result.failed.length };
          }
          if (trashedIds.size === 0) {
            return { status: "failed", failures: result.failed };
          }
          return {
            status: "done",
            trashed: trashedIds.size,
            failed: result.failed.length,
            bytes: bytesFor(trashedIds),
            failures: result.failed,
            catalogWarning: result.catalogError ?? undefined,
          };
        } catch (e) {
          set({ busy: false, canceling: false, progress: null });
          throw e;
        }
      },

      // Albums
      createAlbum: async (name, itemIds) => {
        const trimmed = name.trim();
        if (!trimmed) return;

        const album = await tauri.albums.create(trimmed);
        const ids = itemIds ?? (get().selectedIds.length ? get().selectedIds : []);
        if (ids.length) await tauri.albums.addItems(album.id, ids);

        // Reflect the new membership immediately. The album response only
        // carries the count at creation time, so seed it with the visible ids
        // we just added and hydrate the matching items' albumIds locally.
        const visibleCount = ids.filter((id) => {
          const item = get().items.find((i) => i.id === id);
          return item && !item.hidden;
        }).length;
        const visibleSize = ids
          .map((id) => get().items.find((i) => i.id === id))
          .filter((item): item is MediaItem => !!item && !item.hidden)
          .reduce((sum, item) => sum + (item.size || 0), 0);
        const created = { ...album, itemIds: ids, itemCount: visibleCount, itemSize: visibleSize };
        const coverItems = ids
          .map((id) => get().items.find((item) => item.id === id))
          .filter(
            (item): item is MediaItem =>
              !!item && !item.hidden && (item.kind === "photo" || item.kind === "video"),
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
              itemSize: visibleSize,
              coverItems,
            },
          ],
          items: s.items.map((item) =>
            ids.includes(item.id)
              ? {
                  ...item,
                  albumIds: Array.from(new Set([...(item.albumIds || []), created.id])),
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
          albumOverviews: s.albumOverviews.map((a) => (a.id === albumId ? { ...a, name } : a)),
        }));
      },

      reorderAlbums: async (albumIds) => {
        // The two derived lists must move together or a card and its overview
        // would disagree about where it sits until the next reload.
        const previous = {
          albums: get().albums,
          albumOverviews: get().albumOverviews,
        };
        const orderIndex = new Map(albumIds.map((id, index) => [id, index]));
        const sortByOrder = <T extends { id: string }>(list: T[]): T[] =>
          [...list].sort(
            (a, b) =>
              (orderIndex.get(a.id) ?? albumIds.length) - (orderIndex.get(b.id) ?? albumIds.length),
          );
        set((s) => ({
          albums: sortByOrder(s.albums),
          albumOverviews: sortByOrder(s.albumOverviews),
        }));
        try {
          await tauri.albums.reorder(albumIds);
          return true;
        } catch (error) {
          set(previous);
          get().showErrorNotice(error, "Could not save the album order");
          return false;
        }
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
                  albumIds: Array.from(new Set([...(item.albumIds || []), albumId])),
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
        const albumName = current.albums.find((album) => album.id === albumId)?.name;
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
                  albumIds: (item.albumIds || []).filter((id) => id !== albumId),
                }
              : item,
          ),
          albums: s.albums.map((album) =>
            album.id === albumId
              ? {
                  ...album,
                  itemCount: Math.max(0, (album.itemCount || 0) - removedIds.length),
                }
              : album,
          ),
          albumOverviews: s.albumOverviews.map((album) =>
            album.id === albumId
              ? {
                  ...album,
                  itemCount: Math.max(0, (album.itemCount || 0) - removedIds.length),
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
            s.activeAlbum === albumId && s.inspectedId && removedIds.includes(s.inspectedId)
              ? null
              : s.inspectedId,
        }));
        get().refreshDerived();
        const albumName = current.albums.find((album) => album.id === albumId)?.name;
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
          get().showErrorNotice(error, "Could not load Smart Albums");
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
          favorite: state.filter === "Favorites" ? true : undefined,
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
        await get().createSmartAlbumFrom(trimmed, filter);
      },

      // Creating from the Albums screen starts from an explicit definition
      // rather than whatever the Library happens to be filtered to.
      createSmartAlbumFrom: async (name, filter) => {
        const trimmed = name.trim();
        if (!trimmed) return false;
        try {
          const album = await tauri.smartAlbums.create(trimmed, filter);
          set((s) => ({ smartAlbums: sortSmartAlbums([...s.smartAlbums, album]) }));
          get().showNotice(`Saved Smart Album "${album.name}".`);
          return true;
        } catch (error) {
          get().showErrorNotice(error, "Could not save Smart Album");
          return false;
        }
      },

      updateSmartAlbum: async (albumId, name, filter) => {
        const trimmed = name.trim();
        if (!trimmed) return false;
        try {
          const album = await tauri.smartAlbums.update(albumId, trimmed, filter);
          set((s) => ({
            smartAlbums: sortSmartAlbums(
              s.smartAlbums.map((entry) => (entry.id === albumId ? album : entry)),
            ),
          }));
          get().showNotice(`Updated Smart Album "${album.name}".`);
          return true;
        } catch (error) {
          get().showErrorNotice(error, "Could not update Smart Album");
          return false;
        }
      },

      renameSmartAlbum: async (albumId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        try {
          await tauri.smartAlbums.rename(albumId, trimmed);
          set((s) => ({
            smartAlbums: sortSmartAlbums(
              s.smartAlbums.map((album) =>
                album.id === albumId ? { ...album, name: trimmed } : album,
              ),
            ),
          }));
        } catch (error) {
          get().showErrorNotice(error, "Could not rename Smart Album");
        }
      },

      deleteSmartAlbum: async (albumId) => {
        try {
          await tauri.smartAlbums.delete(albumId);
          set((s) => ({
            smartAlbums: s.smartAlbums.filter((album) => album.id !== albumId),
            activeSmartAlbum: s.activeSmartAlbum === albumId ? null : s.activeSmartAlbum,
          }));
          get().showNotice("Smart Album deleted. Photos were not changed.");
        } catch (error) {
          get().showErrorNotice(error, "Could not delete Smart Album");
        }
      },

      openSmartAlbum: async (albumId) => {
        const album = get().smartAlbums.find((entry) => entry.id === albumId);
        if (!album) {
          get().showNotice("That Smart Album no longer exists.", "notFound");
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
            duplicatesScanned: true,
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
          set({ busy: false, canceling: false, progress: null });
          if (cancelled) get().showNotice("Duplicate scan cancelled.");
          else get().showNotice("Duplicate scan failed", errorCode(e) ?? "internal");
        }
      },

      cancelScan: async () => {
        set({ canceling: true });
        try {
          // Duplicate scanning reports its phase as "hashing"; route its
          // cancellation to the duplicates command instead of the scanner's.
          const phase = get().progress?.phase;
          if (phase === "hashing") await tauri.duplicates.cancel();
          else await tauri.library.cancelScan();
        } catch (e) {
          set({ canceling: false });
          get().showErrorNotice(e, "Could not cancel scan");
        } finally {
          // Always clear canceling state - the backend flag is handled by next scan
          set({ canceling: false });
        }
      },

      cancelDelete: async () => {
        set({ canceling: true });
        try {
          await tauri.items.cancelMoveToTrash();
        } catch (e) {
          set({ canceling: false });
          get().showErrorNotice(e, "Could not cancel deletion");
        }
      },

      clearDuplicates: () => set({ duplicates: [], duplicatesScanned: false }),

      // UI
      setBusy: (busy) => set({ busy, ...(busy ? {} : { canceling: false }) }),
      setProgress: (progress) => set({ progress }),
      showNotice: (text, code = null, action) => {
        const noticeAction = text ? (action ?? null) : null;
        set({ notice: text, noticeCode: code ?? null, noticeAction });
        if (text) {
          // A notice carrying an action lingers longer: it must stay reachable
          // long enough for the user to notice the toast and undo.
          const dwell = code ? 8000 : noticeAction ? 10000 : 3600;
          setTimeout(() => set({ notice: "", noticeCode: null, noticeAction: null }), dwell);
        }
      },

      showErrorNotice: (error, prefix) => {
        const message = describeError(error);
        get().showNotice(
          prefix ? `${prefix}: ${message}` : message,
          errorCode(error) ?? "internal",
        );
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
    useShallow(
      (s) =>
        s.selectedIds.map((id) => s.items.find((i) => i.id === id)).filter(Boolean) as MediaItem[],
    ),
  );
export const useSelectionCount = () => useLibraryStore((s) => s.selectedIds.length);
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
export const useActiveSmartAlbum = () => useLibraryStore((s) => s.activeSmartAlbum);
export const useDuplicates = () => useLibraryStore((s) => s.duplicates);
export const useBusy = () => useLibraryStore((s) => s.busy);
export const useLibraryRefreshing = () => useLibraryStore((s) => s.refreshingLibrary);
export const useProgress = () => useLibraryStore((s) => s.progress);
export const useNotice = () => useLibraryStore((s) => s.notice);
