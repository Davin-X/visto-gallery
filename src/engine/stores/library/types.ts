import type {
  MediaItem,
  Album,
  Tag,
  LibraryFilter,
  DuplicateGroup,
  SimilarGroup,
  Filter,
  LayoutMode,
  Screen,
} from "../../types/media";
import type {
  AlbumOverview,
  DeleteItemsOutcome,
  LibraryFolder,
  LibraryFilterDTO,
  SmartAlbum,
  SmartAlbumFilter,
  ErrorCode,
} from "../../types/commands";

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
  burstGroups: SimilarGroup[];
  burstScanned: boolean;
  /** Library folder the last scan was limited to, or null for the whole
   *  catalog. Results belong to the scope they were scanned in. */
  duplicateScope: string | null;
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
  // Tags applied by a Smart Album. There is no manual tag picker in the
  // Library, so this is set only when a saved definition with `tags` opens;
  // the backend already supports the filter.
  tagsFilter: string[];
  // Which collection the viewer navigates when it opens. Hidden items are
  // deliberately absent from the normal viewer, so the Hidden gallery asks the
  // viewer to browse the hidden set instead. The Map hands over its own set.
  viewerScope: "library" | "hidden" | "map";
  // The photos the Map opened the viewer with, in map order.
  mapItems: MediaItem[];
  timelineCache?: import("../../../screens/timeline/monthCache").MonthCache;

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
  setTagsFilter: (tags: string[]) => void;
  setCameraFilter: (camera: string | null) => void;
  setLensFilter: (lens: string | null) => void;
  setLayout: (layout: LayoutMode) => void;
  setDateRange: (from: number | null, to: number | null) => void;
  setSort: (sortBy: LibraryState["sortBy"], sortOrder: LibraryState["sortOrder"]) => void;
  setScreen: (screen: Screen) => void;
  setViewerScope: (scope: "library" | "hidden" | "map") => void;
  setMapItems: (items: MediaItem[]) => void;
  getCurrentLibraryFilter: () => LibraryFilterDTO;
  toggleInspector: () => void;
  toggleSidebar: () => void;
  toggleSidebarCollapsed: () => void;
  setActiveAlbum: (albumId: string | null) => void;

  // Actions - Items
  /**
   * Make one item part of the loaded page even when the current query did not
   * page it in — Finder "Open With" plays a file imported moments ago that may
   * sort outside the first page. The next library load replaces it, so this
   * never changes what the query means.
   */
  includeItem: (item: MediaItem) => void;
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
  scanSimilar: (overrideScope?: string | null) => Promise<void>;
  cancelScan: () => Promise<void>;
  clearDuplicates: () => void;
  setBurstGroups: (groups: SimilarGroup[]) => void;
  setBurstScanned: (scanned: boolean) => void;
  clearBurstGroups: () => void;
  /** Limit the next scan to one folder (or back to the whole catalog). */
  setDuplicateScope: (path: string | null) => void;

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
