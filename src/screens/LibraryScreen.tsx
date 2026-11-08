import type { CSSProperties } from "react";
import React, {
  useState,
  useMemo,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  useDeferredValue,
} from "react";
import { useKeyboard } from "../engine/hooks/useKeyboard";
import {
  AlbumsIcon,
  BatchIcon,
  CheckIcon,
  DetailsIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  GridIcon,
  HeartIcon,
  ImageOffIcon,
  MinusIcon,
  MoreIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  TagIcon,
  TimelineIcon,
  TrashIcon,
} from "../design/components/icons";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import { PanelResizer } from "../design/components/PanelResizer";
import { KindBadge, KindDot } from "../design/components/KindBadge";
import VideoThumb from "../design/components/VideoThumb";
import { AlbumPhotoStack } from "../design/components/AlbumPhotoStack";
import { useDraftTransforms } from "../engine/stores/useEditStore";
import { draftImageStyle } from "../engine/utils/draftImage";
import { searchShortcutLabel } from "../engine/utils/shortcut";
import { useLibraryStore, libraryViewKey } from "../engine/stores/useLibraryStore";
import { usePlaybackStore } from "../engine/stores/usePlaybackStore";
import { FilterDropdown } from "../design/components/FilterDropdown";
import { useSettingsStore } from "../engine/stores/useSettingsStore";
import { useThumbnailSize, useInspectorWidth } from "../engine/stores/useSettingsStore";
import { tauri } from "../engine/commands/tauri";
import { formatBytesSimple, canPlayVideoInApp } from "../engine/utils/mediaTypes";
import type { MediaItem, Album, Filter, LayoutMode } from "../engine/types/media";
import type { DeleteItemsOutcome, LibraryFolder } from "../engine/types/commands";

const GALLERY_PAGE_SIZE = 180;
const VIRTUAL_GRID_OVERSCAN_ROWS = 6;
const MAX_VIRTUAL_GRID_ITEMS = 480;
const GRID_HORIZONTAL_PADDING = 40;

/**
 * Scroll offsets remembered per view.
 *
 * Switching a type tab, album, source or screen used to send the user back to
 * the top of the grid. The map lives at module scope so it survives the
 * Library screen unmounting during navigation. Only the most recent views are
 * kept; older entries fall off so the map cannot grow without bound.
 */
interface RememberedScroll {
  scrollTop: number;
  /** Items loaded when the offset was taken, used to refill the same depth. */
  itemCount: number;
  /** Progressive-render limit for the non-virtual layouts. */
  renderLimit: number;
}
const rememberedScroll = new Map<string, RememberedScroll>();
const MAX_REMEMBERED_SCROLL_VIEWS = 40;

function rememberScroll(key: string, value: RememberedScroll) {
  rememberedScroll.delete(key);
  rememberedScroll.set(key, value);
  while (rememberedScroll.size > MAX_REMEMBERED_SCROLL_VIEWS) {
    const oldest = rememberedScroll.keys().next().value;
    if (oldest === undefined) break;
    rememberedScroll.delete(oldest);
  }
}

/** Pure row-window calculation for the fixed-height grid and overview cards. */
export function calculateVirtualGridWindow(
  itemCount: number,
  columns: number,
  rowStride: number,
  gap: number,
  scrollTop: number,
  viewportHeight: number,
) {
  const totalRows = Math.ceil(itemCount / columns);
  const firstVisibleRow = Math.max(0, Math.floor(scrollTop / rowStride));
  const lastVisibleRow = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / rowStride));
  const startRow = Math.max(0, firstVisibleRow - VIRTUAL_GRID_OVERSCAN_ROWS);
  const requestedEndRow = Math.min(
    totalRows,
    Math.max(lastVisibleRow + VIRTUAL_GRID_OVERSCAN_ROWS, startRow + 1),
  );
  // Cap the DOM even on very wide monitors with many grid columns.
  const maxWindowRows = Math.max(1, Math.floor(MAX_VIRTUAL_GRID_ITEMS / columns));
  const endRow = Math.min(requestedEndRow, startRow + maxWindowRows);

  return {
    startIndex: startRow * columns,
    endIndex: Math.min(itemCount, endRow * columns),
    topSpacer: startRow ? Math.max(0, startRow * rowStride - gap) : 0,
    bottomSpacer: endRow < totalRows ? Math.max(0, (totalRows - endRow) * rowStride - gap) : 0,
  };
}

interface LibraryScreenProps {
  activeAlbum: string | null;
  albumDragOver?: boolean;
  albums: Album[];
  assetUrl: (path: string) => string;
  busy: boolean;
  filter: Filter;
  hasItems?: boolean;
  hiddenCount: number;
  hiddenView?: boolean;
  inspectedId: string | null;
  items: MediaItem[];
  layout: LayoutMode;
  onAddItems?: (albumId: string) => void;
  onAlbumMenu?: (e: React.MouseEvent) => void;
  onBrowseLibrary?: () => void;
  onChangeFilter: (filter: Filter) => void;
  onChangeLayout: (layout: LayoutMode) => void;
  onChangeQuery: (query: string) => void;
  onClearSelection: () => void;
  onContextMenu: (items: any[], e: React.MouseEvent) => void;
  onCopyTagsToFinder?: (ids: string[]) => void | Promise<void>;
  onCreateAlbum: (itemIds?: string[]) => void;
  onImportFiles?: () => void;
  onImportFolder?: () => void;
  onInspectItem: (id: string) => void;
  onOpenAlbumPicker: (itemIds?: string[]) => void;
  onOpenAlbums: () => void;
  onOpenBatch?: (ids?: string[]) => void;
  onOpenEdit: (item: MediaItem) => void;
  onOpenViewer: (id?: string) => void;
  /** Start a background session for a video without leaving the grid. */
  onPlayBackground?: (id: string) => void;
  onPlaySlideshow: (ids?: string[]) => void;
  onRequestDeleteItems: (ids: string[]) => void;
  onRequestRemoveFromAlbum?: (albumId: string, itemIds: string[]) => void;
  onSelectRange: (startId: string, endId: string) => void;
  onSetActiveAlbum: (albumId: string | null) => void;
  onSetFavoriteForIds: (ids: string[], favorite: boolean) => void | Promise<void>;
  onSetHiddenForIds: (ids: string[], hidden: boolean) => void | Promise<void>;
  onSetSelection: (ids: string[]) => void;
  onSetRatingForIds: (ids: string[], rating: number) => void | Promise<void>;
  onSetColorLabelForIds: (ids: string[], colorLabel: string) => void | Promise<void>;
  onToggleFavorite: (id: string) => void | Promise<void>;
  onToggleHidden: (id: string) => void | Promise<void>;
  onToggleInspector: () => void;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onDeleteItems: (ids: string[]) => void | Promise<DeleteItemsOutcome>;
  onUpdateTags: (id: string, tags: string[]) => void | Promise<void>;
  query: string;
  minRating: number | null;
  libraryStats?: {
    photos: number;
    videos: number;
    raws: number;
    animations?: number;
    favorites: number;
  };
  colorLabelFilter: string | null;
  dateFrom: number | null;
  dateTo: number | null;
  onSetMinRating: (rating: number | null) => void;
  onSetColorLabelFilter: (colorLabel: string | null) => void;
  onSetDateRange: (from: number | null, to: number | null) => void;
  onCreateSmartAlbum?: (name: string) => void;
  notice: any;
  progress: any;
  searchInputRef: any;
  selectedIds: string[];
  showInspector: boolean;
}

function LibraryScreen(props: LibraryScreenProps) {
  const library = useLibraryStore();
  const playingId = usePlaybackStore((state) => state.itemId);
  const isPlaying = usePlaybackStore((state) => state.playing);
  /** In sync with the top bar: starts the item, or toggles its session. */
  const toggleBackground = (item: any) => {
    if (!item) return;
    if (usePlaybackStore.getState().itemId === item.id) {
      usePlaybackStore.getState().toggle();
      return;
    }
    props.onPlayBackground?.(item.id);
  };
  const [showRefreshHint, setShowRefreshHint] = useState(false);
  useEffect(() => {
    if (!library.refreshingLibrary) {
      setShowRefreshHint(false);
      return;
    }
    // Do not flash a spinner for cheap local queries. Only very large or
    // uncached refreshes earn a subtle indication.
    const timer = window.setTimeout(() => setShowRefreshHint(true), 180);
    return () => window.clearTimeout(timer);
  }, [library.refreshingLibrary]);
  const draftTransforms = useDraftTransforms();
  const thumbnailSize = useThumbnailSize();
  const showExtensions = useSettingsStore((s) => s.showExtensions);
  const updateSettings = useSettingsStore((s) => s.update);
  const inspectorWidth = useInspectorWidth();
  const inspectorRef = useRef<HTMLDivElement>(null);

  // A width persisted on a large display must not squeeze the grid below a
  // usable size when the window is later made narrower. The drag handle uses
  // the same bound; this keeps the resting layout honest after a window resize.
  useEffect(() => {
    if (!props.showInspector) return;
    const clampWidth = () => {
      const layout = inspectorRef.current;
      if (!layout) return;
      const max = Math.min(480, Math.max(240, layout.clientWidth - 360));
      if (inspectorWidth > max) void updateSettings("inspectorWidth", max);
    };
    clampWidth();
    window.addEventListener("resize", clampWidth);
    return () => window.removeEventListener("resize", clampWidth);
  }, [inspectorWidth, props.showInspector, updateSettings]);

  const sortDirectionLabel =
    library.sortBy === "capturedAt" || library.sortBy === "modifiedAt"
      ? library.sortOrder === "asc"
        ? "Oldest"
        : "Newest"
      : library.sortBy === "name"
        ? library.sortOrder === "asc"
          ? "A–Z"
          : "Z–A"
        : library.sortBy === "size"
          ? library.sortOrder === "asc"
            ? "Smallest"
            : "Largest"
          : library.sortOrder === "asc"
            ? "Ascending"
            : "Descending";
  const nextSortDirectionLabel =
    library.sortBy === "capturedAt" || library.sortBy === "modifiedAt"
      ? library.sortOrder === "asc"
        ? "newest first"
        : "oldest first"
      : library.sortBy === "name"
        ? library.sortOrder === "asc"
          ? "Z to A"
          : "A to Z"
        : library.sortBy === "size"
          ? library.sortOrder === "asc"
            ? "largest first"
            : "smallest first"
          : library.sortOrder === "asc"
            ? "descending by media type"
            : "ascending by media type";
  // The grid can request a cached JPEG instead of decoding the original. Use
  // roughly 2x the CSS tile width so retina displays stay sharp; the details
  // preview is only 42-52 px, so a 128 px thumbnail is plenty there.
  const thumbnailPixels =
    props.layout === "overview" ? 1024 : props.layout === "details" ? 128 : 512;
  // Hidden items are masked by default. A pointer-down reveals just that tile
  // while it is held; releasing (or leaving the tile) puts the veil back.
  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => new Set());
  const concealAll = useCallback(() => {
    setRevealedIds((prev) => (prev.size ? new Set() : prev));
  }, []);
  const revealItem = useCallback((id: string) => {
    setRevealedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const concealItem = useCallback((id: string) => {
    setRevealedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);
  useEffect(() => {
    concealAll();
  }, [props.hiddenView, props.filter, props.query, props.layout, concealAll]);
  useEffect(() => {
    if (!props.hiddenView) return;
    // A pointer released outside the tile still ends the reveal. Window blur
    // covers alt-tab, which should never leave hidden media exposed.
    window.addEventListener("pointerup", concealAll);
    window.addEventListener("blur", concealAll);
    return () => {
      window.removeEventListener("pointerup", concealAll);
      window.removeEventListener("blur", concealAll);
    };
  }, [props.hiddenView, concealAll]);
  const masked = (item: any) => Boolean(props.hiddenView) && !revealedIds.has(item.id);
  const tileAlt = (item: any) => (masked(item) ? "Hidden item" : item.name);
  const holdHandlers = (id: string) =>
    props.hiddenView
      ? {
          onPointerDown: () => revealItem(id),
          onPointerUp: () => concealItem(id),
          onPointerLeave: () => concealItem(id),
          onPointerCancel: () => concealItem(id),
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === " " || event.key === "Enter") revealItem(id);
          },
          onKeyUp: (event: React.KeyboardEvent) => {
            if (event.key === " " || event.key === "Enter") concealItem(id);
          },
        }
      : {};
  const assetUrl = props.assetUrl;
  // `activeAlbum` is the album id; the heading needs its display name.
  const activeAlbumRecord = props.activeAlbum
    ? props.albums?.find((album: any) => album.id === props.activeAlbum)
    : null;
  const activeAlbumName = props.activeAlbum ? (activeAlbumRecord?.name ?? "Album") : null;
  const inAlbum = Boolean(props.activeAlbum);
  const activeAlbumItems = useMemo(
    () =>
      props.activeAlbum
        ? (library.albumItems?.[props.activeAlbum] ??
          library.items.filter(
            (item: any) => item.albumIds?.includes(props.activeAlbum) && !item.hidden,
          ))
        : [],
    [library.items, library.albumItems, props.activeAlbum],
  );
  const activeAlbumPhotos = useMemo(
    () =>
      activeAlbumItems
        .filter((item: any) => item.kind === "photo" || item.kind === "video")
        .slice(0, 3),
    [activeAlbumItems],
  );
  // Hidden items do not count toward an album while they are hidden; the
  // backend applies the same rule, so a reload and the live UI agree.
  const activeAlbumCount = activeAlbumItems.length;
  const albumEmpty = inAlbum && activeAlbumCount === 0;
  // Filter counts should describe the collection on screen, not the whole
  // library while an album or a source is selected.
  const sourceItems = useMemo(() => {
    if (props.hiddenView) return library.hiddenItems;
    if (!library.activeSource) return library.items;
    const prefix = `${library.activeSource.replace(/\/$/, "")}/`;
    return library.items.filter(
      (item: any) => item.path === library.activeSource || item.path.startsWith(prefix),
    );
  }, [library.items, library.hiddenItems, library.activeSource, props.hiddenView]);
  const filterSource = inAlbum ? activeAlbumItems : sourceItems;
  // The SHOW row used to run one full filter pass per chip on every render.
  // One pass keeps the counts in sync and is O(n) instead of 6 × O(n).
  const filterCounts = useMemo(() => {
    const counts = { All: 0, Photos: 0, Videos: 0, RAW: 0, Animations: 0, Favorites: 0 };
    for (const item of filterSource) {
      if (!props.hiddenView && item.hidden) continue;
      counts.All += 1;
      if (item.kind === "photo") counts.Photos += 1;
      else if (item.kind === "video") counts.Videos += 1;
      else if (item.kind === "raw") counts.RAW += 1;
      // Animated items are also photos; the chip is a narrower view, not a
      // separate kind, so it never changes the Photos or All counts.
      if (item.isAnimated) counts.Animations += 1;
      if (item.favorite) counts.Favorites += 1;
    }
    return counts;
  }, [filterSource, props.hiddenView]);
  // The picker shows the folder name, which can be long enough to widen the
  // whole header row. CSS clamps it and ellipsizes; the full name stays
  // reachable through this tooltip and the native option list.
  const activeSourceName = useMemo(
    () => library.folders.find((f: LibraryFolder) => f.path === library.activeSource)?.name ?? null,
    [library.folders, library.activeSource],
  );
  const hasActiveRefinements = props.hiddenView
    ? Boolean((props.query || "").trim() || props.filter !== "All")
    : Boolean(
        (props.query || "").trim() ||
        props.filter !== "All" ||
        library.activeSource ||
        library.activeSmartAlbum ||
        library.cameraFilter ||
        library.lensFilter ||
        props.minRating !== null ||
        props.colorLabelFilter ||
        props.dateFrom != null ||
        props.dateTo != null,
      );
  const clearRefinements = () => {
    if (props.hiddenView) library.clearHiddenFilters();
    else library.clearFilters();
  };

  const emptyView = () => {
    if (props.hiddenView) {
      const nothingHidden = props.hiddenCount === 0;
      return (
        <div className="empty-state" style={{ gridColumn: "1/-1" }}>
          <span>{nothingHidden ? <EyeOffIcon size={28} /> : <ImageOffIcon size={28} />}</span>
          <b>{nothingHidden ? "Nothing is hidden" : "No hidden items match"}</b>
          <p>
            {nothingHidden
              ? "Select items in Library and choose Hide. Hidden items stay on disk at their original paths and are not encrypted."
              : "Try another filter or search."}
          </p>
          {nothingHidden ? (
            <button
              className="primary-button"
              type="button"
              onClick={() => props.onBrowseLibrary?.()}
            >
              Browse Library
            </button>
          ) : (
            <button type="button" onClick={clearRefinements}>
              Clear filters
            </button>
          )}
        </div>
      );
    }
    return (
      <div
        className={`empty-state${albumEmpty ? " album-empty-dropzone" : ""}${albumEmpty && props.albumDragOver ? " is-dragging" : ""}`}
        style={{ gridColumn: "1/-1" }}
      >
        <span>{albumEmpty ? <AlbumsIcon size={30} /> : <ImageOffIcon size={28} />}</span>
        <b>
          {albumEmpty
            ? props.albumDragOver
              ? "Drop to add to this album"
              : "This album is empty"
            : props.hasItems === false
              ? "Your library is empty"
              : "No items match"}
        </b>
        <p>
          {albumEmpty
            ? "Drag files here or use Add Items. You can also select photos in Library and choose Add to album."
            : props.hasItems === false
              ? "Add a folder to start indexing photos and videos."
              : "Try another filter or search."}
        </p>
        {albumEmpty ? (
          <div className="album-empty-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => props.activeAlbum && props.onAddItems?.(props.activeAlbum)}
            >
              <PlusIcon size={14} /> Add Items
            </button>
            <button
              className="quiet-button"
              type="button"
              onClick={() => {
                props.onSetActiveAlbum?.(null);
                props.onChangeFilter?.("All");
                props.onChangeQuery?.("");
              }}
            >
              Browse Library
            </button>
          </div>
        ) : props.hasItems === false ? (
          <button className="primary-button" type="button" onClick={() => props.onImportFolder?.()}>
            <PlusIcon size={14} /> Add a folder
          </button>
        ) : (
          <button type="button" onClick={clearRefinements}>
            Clear filters
          </button>
        )}
      </div>
    );
  };

  // Progressive rendering. A library can hold tens of thousands of items and
  // mounting a tile for every one makes typing, clicking and filtering janky
  // (the whole grid reconciles on each state change). Render a page at a time
  // and extend it as the user scrolls, so the DOM stays small.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [renderLimit, setRenderLimit] = useState(GALLERY_PAGE_SIZE);
  const [gridViewport, setGridViewport] = useState({
    width: 0,
    height: 0,
    scrollTop: 0,
  });
  const [measuredTileHeight, setMeasuredTileHeight] = useState<number | null>(null);
  const virtualFrame = useRef<number | null>(null);
  const restoringScrollRef = useRef(false);
  const restoredScrollKeyRef = useRef<string | null>(null);

  // A view is the filter/query/album/source combination plus the layout and
  // thumbnail size, because the same item offset maps to different pixels in
  // each layout. Hidden has its own filter state, so it gets its own prefix.
  const viewKey = props.hiddenView
    ? `hidden:${library.hiddenFilter}:${library.hiddenQuery}`
    : libraryViewKey(library);
  const scrollKey = `${viewKey}|${props.layout}|${thumbnailSize}${props.hiddenView ? "|hidden" : ""}`;
  const scrollKeyRef = useRef(scrollKey);
  scrollKeyRef.current = scrollKey;
  const renderLimitRef = useRef(renderLimit);
  renderLimitRef.current = renderLimit;

  // The standard grid and overview use fixed-ratio cards, so their full
  // scroll height can be represented by two spacers while only nearby rows
  // stay mounted. Details, timeline and masonry retain their specialised
  // renderers; their rows, groups and heights need different virtualizers.
  const supportsGridVirtualization = props.layout === "grid" || props.layout === "overview";
  const updateGridViewport = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const next = {
      width: node.clientWidth,
      height: node.clientHeight,
      scrollTop: node.scrollTop,
    };
    setGridViewport((previous) =>
      previous.width === next.width &&
      previous.height === next.height &&
      previous.scrollTop === next.scrollTop
        ? previous
        : next,
    );
  }, []);
  const scheduleViewportUpdate = useCallback(() => {
    if (virtualFrame.current !== null) return;
    virtualFrame.current = window.requestAnimationFrame(() => {
      virtualFrame.current = null;
      updateGridViewport();
    });
  }, [updateGridViewport]);

  useLayoutEffect(() => {
    updateGridViewport();
    const node = scrollRef.current;
    if (!node) return;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateGridViewport);
    observer?.observe(node);
    if (!observer) window.addEventListener("resize", updateGridViewport);
    return () => {
      observer?.disconnect();
      if (!observer) window.removeEventListener("resize", updateGridViewport);
      if (virtualFrame.current !== null) {
        window.cancelAnimationFrame(virtualFrame.current);
        virtualFrame.current = null;
      }
    };
  }, [updateGridViewport]);

  useEffect(() => {
    setMeasuredTileHeight(null);
  }, [props.layout, thumbnailSize, gridViewport.width]);

  // Restore the scroll offset saved for this view, refilling the same item
  // depth first so the grid is tall enough to reach the remembered row.
  // Switching to a view with no history still starts at the top.
  useEffect(() => {
    const dataReady = props.hiddenView || library.loadedViewKey === viewKey;
    if (!dataReady || restoringScrollRef.current) return;
    if (restoredScrollKeyRef.current === scrollKey) return;
    restoredScrollKeyRef.current = scrollKey;

    const el = scrollRef.current;
    const saved = rememberedScroll.get(scrollKey);
    if (!el || !saved || (saved.scrollTop <= 0 && saved.renderLimit <= GALLERY_PAGE_SIZE)) {
      setRenderLimit(GALLERY_PAGE_SIZE);
      el?.scrollTo({ top: 0 });
      return;
    }

    setRenderLimit(Math.max(GALLERY_PAGE_SIZE, saved.renderLimit));

    const jumpToSavedOffset = () => {
      restoringScrollRef.current = true;
      window.requestAnimationFrame(() => {
        el.scrollTo({ top: saved.scrollTop });
        window.requestAnimationFrame(() => {
          restoringScrollRef.current = false;
        });
      });
    };

    const refillDepth = async () => {
      if (props.hiddenView) return;
      let state = useLibraryStore.getState();
      let guard = 0;
      while (state.items.length < saved.itemCount && state.hasMore && guard < 100) {
        const before = state.items.length;
        await state.loadNextPage();
        state = useLibraryStore.getState();
        // A newer filter load superseded the restore; stop instead of
        // scrolling unrelated rows into view.
        if (state.items.length === before) break;
        guard += 1;
      }
    };

    void refillDepth().then(jumpToSavedOffset);
    // `restoredScrollKeyRef` makes this run once per view; item-count changes
    // during the depth refill must not restart the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library.loadedViewKey, props.hiddenView, scrollKey, viewKey]);

  const loadMore = () => {
    if (supportsGridVirtualization) {
      // The virtualizer handles local DOM windowing. Near-bottom scrolling
      // should fetch the next catalog page without stepping a second,
      // redundant local render limit.
      if (!library.loadingNextPage && library.hasMore && !library.busy) {
        void library.loadNextPage();
      }
      return;
    }

    const nextRenderLimit = Math.min(renderLimit + GALLERY_PAGE_SIZE, props.items.length);
    setRenderLimit(nextRenderLimit);
    // The screen only renders a local window, while the store owns the next
    // database page. Ask for it only when the already loaded items are also
    // exhausted, so rapid scroll events cannot fan out duplicate IPC calls.
    if (
      nextRenderLimit >= props.items.length &&
      library.hasMore &&
      !library.busy &&
      !library.loadingNextPage
    ) {
      void library.loadNextPage();
    }
  };

  const handleGridScroll = () => {
    scheduleViewportUpdate();
    const el = scrollRef.current;
    if (!el) return;
    // Only remember offsets for the view whose rows are actually on screen; a
    // filter switch clears `loadedViewKey` until the new first page arrives.
    if (!restoringScrollRef.current) {
      const state = useLibraryStore.getState();
      if (props.hiddenView || state.loadedViewKey === viewKey) {
        rememberScroll(scrollKeyRef.current, {
          scrollTop: el.scrollTop,
          itemCount: state.items.length,
          renderLimit: renderLimitRef.current,
        });
      }
    }
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 800) loadMore();
  };
  const handleGridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const rawTarget = (e.target as HTMLElement) || (document.activeElement as HTMLElement);
      const button =
        (rawTarget?.closest?.(".tile-open-button") as HTMLButtonElement | null) ||
        ((document.activeElement as HTMLElement | null)?.closest?.(
          ".tile-open-button",
        ) as HTMLButtonElement | null);
      if (!button) return;
      const buttons = Array.from(
        scrollRef.current?.querySelectorAll<HTMLButtonElement>(".tile-open-button") ?? [],
      );
      const currentIndex = buttons.indexOf(button);
      if (currentIndex < 0) return;
      let columns = 1;
      const firstTop = buttons[0]?.offsetTop;
      for (let i = 1; i < buttons.length; i++) {
        if (buttons[i].offsetTop === firstTop) columns += 1;
        else break;
      }
      if (columns < 1) columns = 1;
      let nextIndex = currentIndex;
      if (e.key === "ArrowRight") nextIndex = currentIndex + 1;
      else if (e.key === "ArrowLeft") nextIndex = currentIndex - 1;
      else if (e.key === "ArrowDown") nextIndex = currentIndex + columns;
      else if (e.key === "ArrowUp") nextIndex = currentIndex - columns;
      else return;
      if (nextIndex < 0 || nextIndex >= buttons.length) return;
      e.preventDefault();
      const nextButton = buttons[nextIndex];
      nextButton.focus();
      const itemId = nextButton.getAttribute("data-item-id");
      if (itemId) props.onInspectItem?.(itemId);
    },
    [props.onInspectItem],
  );

  // Grid arrow-key navigation shares the single window listener via useKeyboard.
  // The handler only acts when a tile-open-button is focused, so it never
  // interferes with inputs or App-level shortcuts (which run first and call
  // preventDefault to stop the chain).
  useKeyboard([
    (e: KeyboardEvent) => handleGridKeyDown(e as unknown as React.KeyboardEvent<HTMLDivElement>),
  ]);

  const renderedItems = useMemo(() => {
    // Virtualized grid/overview layouts already window which tiles the DOM
    // contains, so slicing them a second time creates a misleading "show
    // more" footer and limits scroll-triggered page loading.
    return supportsGridVirtualization ? props.items : props.items.slice(0, renderLimit);
  }, [props.items, renderLimit, supportsGridVirtualization]);
  const virtualGrid = useMemo(() => {
    if (!supportsGridVirtualization || renderedItems.length === 0) {
      return { items: renderedItems, topSpacer: 0, bottomSpacer: 0 };
    }

    const overview = props.layout === "overview";
    const gap = overview ? 20 : 16;
    const minTileWidth = overview
      ? 320
      : thumbnailSize === "small"
        ? 160
        : thumbnailSize === "large"
          ? 280
          : props.showInspector
            ? 210
            : 220;
    const availableWidth = Math.max(minTileWidth, gridViewport.width - GRID_HORIZONTAL_PADDING);
    const columns = Math.max(1, Math.floor((availableWidth + gap) / (minTileWidth + gap)));
    const tileWidth = (availableWidth - gap * (columns - 1)) / columns;
    const estimatedTileHeight = tileWidth * (overview ? 10 / 16 : 1) + 58;
    const rowHeight = measuredTileHeight ?? estimatedTileHeight;
    const rowStride = rowHeight + gap;
    const window = calculateVirtualGridWindow(
      renderedItems.length,
      columns,
      rowStride,
      gap,
      gridViewport.scrollTop,
      gridViewport.height,
    );

    return {
      items: renderedItems.slice(window.startIndex, window.endIndex),
      topSpacer: window.topSpacer,
      bottomSpacer: window.bottomSpacer,
    };
  }, [
    gridViewport.height,
    gridViewport.scrollTop,
    gridViewport.width,
    measuredTileHeight,
    props.layout,
    props.showInspector,
    renderedItems,
    supportsGridVirtualization,
    thumbnailSize,
  ]);

  useLayoutEffect(() => {
    if (!supportsGridVirtualization) return;
    const tile = scrollRef.current?.querySelector<HTMLElement>(
      ".gallery-grid.layout-grid .gallery-tile, .gallery-grid.layout-overview .gallery-tile",
    );
    const height = tile?.getBoundingClientRect().height;
    if (height && (measuredTileHeight === null || Math.abs(measuredTileHeight - height) > 1)) {
      setMeasuredTileHeight(height);
    }
  }, [props.layout, thumbnailSize, gridViewport.width, supportsGridVirtualization]);
  const selectedIdSet = useMemo(() => new Set(props.selectedIds), [props.selectedIds]);

  // Timeline groups use the photo's capture date when available, with file
  // modification time as a reliable fallback for screenshots and videos.
  const timelineGroups: {
    key: string;
    label: string;
    items: any[];
    count: number;
  }[] = useMemo(
    () =>
      props.layout === "timeline"
        ? (() => {
            const grouped = new Map<string, { timestamp: number; items: any[] }>();
            for (const item of props.items) {
              const timestamp = item.capturedAt ?? item.modifiedAt;
              const date = new Date(timestamp);
              const key = `${date.getFullYear()}-${date.getMonth()}`;
              const group = grouped.get(key) ?? {
                timestamp,
                items: [] as any[],
              };
              group.timestamp = Math.max(group.timestamp, timestamp);
              group.items.push(item);
              grouped.set(key, group);
            }
            return [...grouped.entries()]
              .sort((a, b) => b[1].timestamp - a[1].timestamp)
              .map(([key, group]) => ({
                key,
                label: new Intl.DateTimeFormat(undefined, {
                  month: "long",
                  year: "numeric",
                }).format(group.timestamp),
                items: group.items,
                count: group.items.length,
              }));
          })()
        : [],
    [props.items, props.layout],
  );
  const visibleTimelineGroups = useMemo(() => {
    if (!timelineGroups.length) return [];
    const visibleItemsByMonth = new Map<string, any[]>();
    for (const item of renderedItems) {
      const timestamp = item.capturedAt ?? item.modifiedAt;
      const date = new Date(timestamp);
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      const items = visibleItemsByMonth.get(key) ?? [];
      items.push(item);
      visibleItemsByMonth.set(key, items);
    }
    return timelineGroups.flatMap((group) => {
      const visibleItems = visibleItemsByMonth.get(group.key);
      return visibleItems?.length ? [{ ...group, visibleItems }] : [];
    });
  }, [renderedItems, timelineGroups]);

  const captureDate = (item: any) => item.capturedAt ?? item.modifiedAt;
  const sortDetailsBy = (sortBy: typeof library.sortBy) => {
    library.setSort(
      sortBy,
      library.sortBy === sortBy && library.sortOrder === "asc" ? "desc" : "asc",
    );
  };
  const detailsHeader = (label: string, sortBy?: typeof library.sortBy) => (
    <div className="details-col">
      {sortBy ? (
        <button type="button" className="details-sort-header" onClick={() => sortDetailsBy(sortBy)}>
          {label}
          <span aria-hidden="true">
            {library.sortBy === sortBy ? (library.sortOrder === "asc" ? "↑" : "↓") : "↕"}
          </span>
        </button>
      ) : (
        label
      )}
    </div>
  );
  const toggleTimelineGroup = (items: any[]) => {
    const groupIds = items.map((item) => item.id);
    const groupIdSet = new Set(groupIds);
    const allSelected = groupIds.length > 0 && groupIds.every((id) => selectedIdSet.has(id));
    const next = allSelected
      ? props.selectedIds.filter((id: string) => !groupIdSet.has(id))
      : [...new Set([...props.selectedIds, ...groupIds])];
    props.onSetSelection?.(next);
  };

  const lastClickedRef = useRef<string | null>(null);

  // Interaction contract:
  //  - plain single click → inspect the item (Inspector follows; selection untouched)
  //  - shift-click → range-select from the last clicked tile
  //  - Cmd/Ctrl-click → toggle selection membership (inspection untouched)
  //  - double click → inspect + open the viewer on exactly that item
  //  - checkbox → toggle selection membership only
  const handleTileClick = (item: any, e: React.MouseEvent) => {
    if (e.shiftKey && lastClickedRef.current && lastClickedRef.current !== item.id) {
      props.onSelectRange?.(lastClickedRef.current, item.id);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      props.onToggleSelect?.(item.id);
      lastClickedRef.current = item.id;
      return;
    }
    props.onInspectItem?.(item.id);
    lastClickedRef.current = item.id;
  };

  const handleTileDoubleClick = (item: any) => {
    lastClickedRef.current = item.id;
    props.onInspectItem?.(item.id);
    props.onOpenViewer?.(item.id);
  };

  const tileClass = (item: any) =>
    `gallery-tile${props.inspectedId === item.id ? " inspected" : ""}${selectedIdSet.has(item.id) ? " selected" : ""}${item.favorite ? " is-favorite" : ""}${masked(item) ? " hidden-obscured" : ""}`;

  // Right-clicking a photo is the most direct place to manage its album
  // membership. The picker itself carries the album list and search.
  const itemContextMenu = (item: any) => [
    { label: "Open", onClick: () => props.onOpenViewer(item.id) },
    ...(item.kind === "video" && props.onPlayBackground
      ? [
          {
            label: "Play in background",
            onClick: () => toggleBackground(item),
          },
        ]
      : []),
    ...(item.kind === "photo"
      ? [
          {
            label: "Edit",
            onClick: () => {
              props.onOpenEdit?.(item);
            },
          },
        ]
      : []),
    {
      label: "Open in default app",
      onClick: () => tauri.items.openFile(item.path),
    },
    {
      label: "Open in Finder",
      onClick: () => tauri.items.revealInFinder(item.path),
    },
    {
      label: "Copy tags to Finder",
      disabled: !(item.tags || []).length,
      onClick: () => props.onCopyTagsToFinder?.([item.id]),
    },
    { divider: true },
    {
      label: "Add to Album…",
      onClick: () => props.onOpenAlbumPicker?.([item.id]),
    },
    ...(props.activeAlbum
      ? [
          {
            label: "Remove from this Album",
            danger: true,
            onClick: () =>
              props.activeAlbum && props.onRequestRemoveFromAlbum?.(props.activeAlbum, [item.id]),
          },
        ]
      : []),
    { label: "New Album…", onClick: () => props.onCreateAlbum?.([item.id]) },
    { divider: true },
    { label: "Favorite", onClick: () => props.onToggleFavorite(item.id) },
    {
      label: item.rating ? `Rating ${"★".repeat(item.rating)}` : "Rating",
      icon: item.rating ? (
        <span className="ctx-star">★</span>
      ) : (
        <span className="ctx-star ctx-star-empty">☆</span>
      ),
      submenu: [
        {
          label: <span className="ctx-star ctx-star-empty">Unrate</span>,
          onClick: () => props.onSetRatingForIds?.([item.id], 0),
        },
        {
          label: <span className="ctx-star">★</span>,
          onClick: () => props.onSetRatingForIds?.([item.id], 1),
        },
        {
          label: <span className="ctx-star">★★</span>,
          onClick: () => props.onSetRatingForIds?.([item.id], 2),
        },
        {
          label: <span className="ctx-star">★★★</span>,
          onClick: () => props.onSetRatingForIds?.([item.id], 3),
        },
        {
          label: <span className="ctx-star">★★★★</span>,
          onClick: () => props.onSetRatingForIds?.([item.id], 4),
        },
        {
          label: <span className="ctx-star">★★★★★</span>,
          onClick: () => props.onSetRatingForIds?.([item.id], 5),
        },
      ],
    },
    {
      label: "Color Label",
      icon: item.colorLabel ? <span className={`ctx-dot ctx-dot-${item.colorLabel}`} /> : null,
      submenu: [
        {
          label: "None",
          icon: <span className="ctx-dot ctx-dot-none" />,
          onClick: () => props.onSetColorLabelForIds?.([item.id], ""),
        },
        {
          label: "Red",
          icon: <span className="ctx-dot ctx-dot-red" />,
          onClick: () => props.onSetColorLabelForIds?.([item.id], "red"),
        },
        {
          label: "Yellow",
          icon: <span className="ctx-dot ctx-dot-yellow" />,
          onClick: () => props.onSetColorLabelForIds?.([item.id], "yellow"),
        },
        {
          label: "Green",
          icon: <span className="ctx-dot ctx-dot-green" />,
          onClick: () => props.onSetColorLabelForIds?.([item.id], "green"),
        },
        {
          label: "Blue",
          icon: <span className="ctx-dot ctx-dot-blue" />,
          onClick: () => props.onSetColorLabelForIds?.([item.id], "blue"),
        },
        {
          label: "Purple",
          icon: <span className="ctx-dot ctx-dot-purple" />,
          onClick: () => props.onSetColorLabelForIds?.([item.id], "purple"),
        },
      ],
    },
    {
      label: item.hidden ? "Unhide" : "Hide",
      onClick: () => props.onToggleHidden(item.id),
    },
    {
      label: "Delete",
      danger: true,
      onClick: () => props.onRequestDeleteItems?.([item.id]),
    },
  ];

  // Batch actions live in the contextual selection bar, so resolve the
  // selected items once and derive the toggled labels from them.
  const selectedItems = useMemo(() => {
    if (!props.selectedIds.length) return [];
    const ids = new Set(props.selectedIds);
    const pool = props.hiddenView ? library.hiddenItems : library.items;
    return pool.filter((i: any) => ids.has(i.id));
  }, [props.selectedIds, props.hiddenView, library.items, library.hiddenItems]);
  const anySelectedFavorite = selectedItems.some((i: any) => i.favorite);
  const anySelectedHidden = selectedItems.some((i: any) => i.hidden);
  // Play on a video-only selection opens the player; anything with a photo
  // starts a slideshow. The label follows the action so it is never a surprise.
  const selectionPlaysInViewer =
    selectedItems.length > 0 && selectedItems.every((i: any) => i.kind === "video");
  // Say what is actually in the selection: "3 photos · 2 videos" explains the
  // Play/Slideshow label and avoids surprises when a filter hides some of them.
  const selectedKindCounts = useMemo(() => {
    const counts: Record<string, number> = { photo: 0, video: 0, raw: 0 };
    for (const item of selectedItems) counts[item.kind] = (counts[item.kind] || 0) + 1;
    return counts;
  }, [selectedItems]);
  const selectedKindSummary = [
    selectedKindCounts.photo
      ? `${selectedKindCounts.photo} photo${selectedKindCounts.photo === 1 ? "" : "s"}`
      : "",
    selectedKindCounts.video
      ? `${selectedKindCounts.video} video${selectedKindCounts.video === 1 ? "" : "s"}`
      : "",
    selectedKindCounts.raw ? `${selectedKindCounts.raw} RAW` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // Select-all now lives in the selection bar and is scoped to the items the
  // screen is actually showing (including the Hidden and album views).
  const allVisibleSelected =
    props.items.length > 0 && props.items.every((item: any) => selectedIdSet.has(item.id));
  const toggleSelectAllVisible = () => {
    props.onSetSelection?.(allVisibleSelected ? [] : props.items.map((item: any) => item.id));
  };

  return (
    <div
      ref={inspectorRef}
      className={`library-layout ${props.showInspector ? "with-inspector" : ""}`}
      style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}
    >
      <section className="library-center">
        <header className="library-header">
          {inAlbum ? (
            <div className="album-detail-top">
              <button
                className="quiet-button album-breadcrumb"
                type="button"
                onClick={() => props.onOpenAlbums?.()}
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  padding: "8px 12px",
                  gap: 6,
                  marginRight: 12,
                }}
              >
                <span style={{ fontSize: 14 }}>←</span>
                <AlbumsIcon size={17} /> All albums
              </button>
              <div className="album-detail-heading">
                <div className={`album-detail-cover${activeAlbumPhotos.length ? "" : " is-empty"}`}>
                  {activeAlbumPhotos.length ? (
                    <AlbumPhotoStack
                      photos={activeAlbumPhotos}
                      assetUrl={assetUrl}
                      albumItems={activeAlbumItems}
                    />
                  ) : (
                    <AlbumsIcon size={27} />
                  )}
                </div>
                <div className="album-detail-copy">
                  <p className="eyebrow">ALBUM</p>
                  <h1>{activeAlbumName}</h1>
                </div>
                <div className="album-detail-actions">
                  <button
                    className="play-button"
                    type="button"
                    onClick={() => props.onPlaySlideshow?.(props.selectedIds)}
                    disabled={props.busy || props.items.length === 0}
                    title={
                      props.selectedIds.length
                        ? "Play the selected items"
                        : "Play this album as a slideshow"
                    }
                  >
                    <PlayIcon size={14} /> Play
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => props.activeAlbum && props.onAddItems?.(props.activeAlbum)}
                    disabled={props.busy}
                  >
                    <PlusIcon size={15} /> Add Items
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    onClick={(e) => props.onAlbumMenu?.(e)}
                    title="Album options"
                    aria-label="Album options"
                  >
                    <MoreIcon size={18} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <header className="library-header-row">
              <div className="header-left">
                <p className="eyebrow">
                  {props.hiddenView ? "OUT OF THE GALLERY" : "YOUR COLLECTION"}
                </p>
                <div className="header-title-row">
                  <h1>{props.hiddenView ? "Hidden" : "All Photos"}</h1>
                </div>
              </div>
              <div className="header-actions">
                {!props.hiddenView && (
                  <>
                    <label
                      className="source-select"
                      title={
                        activeSourceName
                          ? `Filtering by ${activeSourceName}`
                          : "Filter the library by source"
                      }
                    >
                      <FolderIcon size={14} />
                      <span className="source-select-label">Source</span>
                      <select
                        value={library.activeSource ?? ""}
                        onChange={(e) => library.setActiveSource(e.target.value || null)}
                        aria-label="Filter the library by source"
                      >
                        <option value="">All sources</option>
                        {library.folders.map((folder: LibraryFolder) => (
                          <option key={folder.path} value={folder.path}>
                            {folder.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="quiet-button"
                      type="button"
                      onClick={() => props.onImportFolder?.()}
                      disabled={props.busy}
                      title="Add folder (⌘O)"
                      aria-label="Add folder"
                    >
                      <FolderIcon size={15} />
                      <span className="btn-label">Add folder</span>
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => props.onImportFiles?.()}
                      disabled={props.busy}
                      title="Add files (⌘I)"
                      aria-label="Add files"
                    >
                      <PlusIcon size={15} />
                      <span className="btn-label">Add files</span>
                    </button>
                  </>
                )}
              </div>
            </header>
          )}

          {props.hiddenView && (
            <div className="hidden-disclaimer" role="note">
              <EyeOffIcon size={15} />
              <span>
                Hidden from the gallery only. Files stay on disk at their original paths and are not
                encrypted.
              </span>
            </div>
          )}

          <div className="collection-toolbar">
            <div className="search-field">
              <span className="search-icon">
                <SearchIcon size={15} />
              </span>
              <input
                ref={props.searchInputRef}
                value={props.query}
                onChange={(e) => props.onChangeQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && props.query) props.onChangeQuery("");
                }}
                placeholder={
                  props.hiddenView
                    ? "Search hidden items…"
                    : "Search filenames, tags, camera, lens…"
                }
                aria-label={props.hiddenView ? "Search hidden items" : "Search library"}
              />
              {props.query ? (
                <button
                  type="button"
                  className="clear-btn visible"
                  onClick={() => {
                    props.onChangeQuery("");
                  }}
                  aria-label="Clear search"
                  title="Clear (Esc)"
                >
                  ×
                </button>
              ) : (
                <kbd title="Focus search">{searchShortcutLabel()}</kbd>
              )}
            </div>
            <div className="toolbar-right">
              <div className="toolbar-actions">
                <button
                  className="toolbar-button slideshow-action"
                  type="button"
                  onClick={() => props.onPlaySlideshow?.(props.selectedIds)}
                  disabled={props.busy || props.items.length === 0}
                  title="Play the current view as a slideshow (Space)"
                  aria-label="Play slideshow"
                >
                  <PlayIcon size={14} />
                  <span className="slideshow-label">Slideshow</span>
                </button>
                {!props.hiddenView && (
                  <button
                    className="toolbar-button"
                    type="button"
                    aria-label="Create album"
                    onClick={() => props.onCreateAlbum?.()}
                    title="Create album (⌘N)"
                  >
                    <PlusIcon size={14} /> Album
                  </button>
                )}
                <span className="toolbar-divider" aria-hidden="true" />
                <div className="view-controls" role="group" aria-label="View controls">
                  <div className="layout-switcher" role="group" aria-label="Gallery layout">
                    {(["grid", "details", "timeline"] as const).map((l) => {
                      const Icon =
                        l === "grid" ? GridIcon : l === "details" ? DetailsIcon : TimelineIcon;
                      return (
                        <button
                          key={l}
                          type="button"
                          aria-label={`${l[0].toUpperCase()}${l.slice(1)} view`}
                          title={`${l[0].toUpperCase()}${l.slice(1)} view`}
                          aria-pressed={props.layout === l}
                          className={props.layout === l ? "selected" : ""}
                          onClick={() => props.onChangeLayout(l)}
                        >
                          <Icon size={14} />
                        </button>
                      );
                    })}
                  </div>
                  <div className="zoom-control" role="group" aria-label="Thumbnail size">
                    {(["small", "medium", "large"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`zoom-step ${thumbnailSize === s ? "selected" : ""}`}
                        aria-label={
                          s === "small"
                            ? "Small thumbnails"
                            : s === "medium"
                              ? "Medium thumbnails"
                              : "Large thumbnails"
                        }
                        aria-pressed={thumbnailSize === s}
                        onClick={() => updateSettings("thumbnailSize", s)}
                        title={
                          s === "small"
                            ? "Small thumbnails"
                            : s === "medium"
                              ? "Medium thumbnails"
                              : "Large thumbnails"
                        }
                      >
                        <span className={`zoom-glyph zoom-glyph-${s}`} aria-hidden="true">
                          {Array.from(
                            {
                              length: s === "small" ? 6 : s === "medium" ? 4 : 1,
                            },
                            (_, index) => (
                              <i key={index} />
                            ),
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                {!props.hiddenView && (
                  <div
                    className="sort-control"
                    role="group"
                    aria-label={`Sort options; ${sortDirectionLabel}`}
                  >
                    <select
                      aria-label="Sort library by"
                      value={library.sortBy}
                      onChange={(e) =>
                        library.setSort(e.target.value as typeof library.sortBy, library.sortOrder)
                      }
                    >
                      <option value="capturedAt">Date captured</option>
                      <option value="modifiedAt">Date modified</option>
                      <option value="name">Name</option>
                      <option value="size">File size</option>
                      <option value="kind">Media type</option>
                    </select>
                    <button
                      type="button"
                      aria-label={`Sort ${nextSortDirectionLabel}`}
                      title={`Currently ${sortDirectionLabel}; click to sort ${nextSortDirectionLabel}`}
                      onClick={() =>
                        library.setSort(
                          library.sortBy,
                          library.sortOrder === "asc" ? "desc" : "asc",
                        )
                      }
                    >
                      <span className="sort-direction-arrow" aria-hidden="true">
                        {library.sortOrder === "asc" ? "↑" : "↓"}
                      </span>
                      <span className="sort-direction-label">{sortDirectionLabel}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="filter-cluster" role="group" aria-label="Filter by media type">
            <span className="smart-label">TYPE</span>
            {(["All", "Photos", "Videos", "RAW", "Animations", "Favorites"] as const).map((f) => {
              // Album/collection counts must come from the full collection on
              // screen, not the type-filtered `props.items` (selecting "Photos"
              // in an album with no photos would zero every count).
              const count = props.activeAlbum
                ? filterCounts[f]
                : f === "All"
                  ? (props.libraryStats?.photos ?? 0) +
                    (props.libraryStats?.videos ?? 0) +
                    (props.libraryStats?.raws ?? 0)
                  : f === "Photos"
                    ? (props.libraryStats?.photos ?? 0)
                    : f === "Videos"
                      ? (props.libraryStats?.videos ?? 0)
                      : f === "RAW"
                        ? (props.libraryStats?.raws ?? 0)
                        : f === "Animations"
                          ? (props.libraryStats?.animations ?? 0)
                          : (props.libraryStats?.favorites ?? 0);
              return (
                <button
                  key={f}
                  type="button"
                  aria-pressed={props.filter === f}
                  className={`quick-filter ${props.filter === f ? "active" : ""}`}
                  onClick={() => props.onChangeFilter(f as Filter)}
                >
                  {f}
                  <span className="filter-count">{count}</span>
                </button>
              );
            })}
            <FilterDropdown
              minRating={props.minRating}
              colorLabelFilter={props.colorLabelFilter}
              dateFrom={props.dateFrom}
              dateTo={props.dateTo}
              onSetMinRating={props.onSetMinRating}
              onSetColorLabelFilter={props.onSetColorLabelFilter}
              onSetDateRange={props.onSetDateRange}
              onCreateSmartAlbum={props.onCreateSmartAlbum}
            />
            {hasActiveRefinements && (
              <button
                type="button"
                className="quick-filter clear-refinements-button"
                onClick={clearRefinements}
                aria-label="Clear all filters"
                title="Clear search and all filter refinements"
              >
                Clear all
              </button>
            )}
            {!props.hiddenView && showRefreshHint && (
              <span className="filter-refreshing" role="status">
                <span className="filter-refreshing-spinner" aria-hidden="true" />
                Refreshing…
              </span>
            )}
          </div>

          {props.selectedIds.length > 0 && (
            <div className="selection-bar" role="toolbar" aria-label="Selection actions">
              <div className="selection-bar-left">
                <span className="selection-bar-count">
                  {props.selectedIds.length.toLocaleString()} selected
                </span>
                <span className="selection-bar-divider" aria-hidden="true" />
                <span className="selection-bar-size">
                  {formatBytesSimple(
                    selectedItems.reduce((sum: number, item: any) => sum + (item.size || 0), 0),
                  )}{" "}
                  selected
                </span>
                {selectedKindSummary && (
                  <>
                    <span className="selection-bar-divider" aria-hidden="true" />
                    <span className="selection-bar-kinds">{selectedKindSummary}</span>
                  </>
                )}
              </div>
              <div className="selection-bar-actions">
                <button
                  type="button"
                  className="selection-bar-action selection-bar-clear"
                  onClick={() => props.onClearSelection?.()}
                  title="Clear selection (inspection is kept)"
                >
                  Clear
                </button>
                <span className="selection-bar-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="selection-bar-action"
                  onClick={toggleSelectAllVisible}
                  title={allVisibleSelected ? "Deselect all shown items" : "Select all shown items"}
                >
                  <CheckIcon size={12} />
                  {allVisibleSelected ? "Deselect all" : "Select all"}
                </button>
                <button
                  type="button"
                  className="selection-bar-action"
                  onClick={() => props.onPlaySlideshow?.(props.selectedIds)}
                  title={
                    selectionPlaysInViewer
                      ? "Play the selected videos in the viewer"
                      : "Play selected items as a slideshow"
                  }
                >
                  <PlayIcon size={13} /> {selectionPlaysInViewer ? "Play" : "Slideshow"}
                </button>
                <button
                  type="button"
                  className="selection-bar-action"
                  onClick={() => props.onSetFavoriteForIds(props.selectedIds, !anySelectedFavorite)}
                  title={
                    anySelectedFavorite
                      ? "Remove favorite from all selected"
                      : "Favorite all selected"
                  }
                >
                  <HeartIcon size={13} filled={anySelectedFavorite} />
                  {anySelectedFavorite ? "Unfavorite" : "Favorite"}
                </button>
                <button
                  type="button"
                  className="selection-bar-action"
                  onClick={() => props.onSetHiddenForIds(props.selectedIds, !anySelectedHidden)}
                  title={anySelectedHidden ? "Unhide all selected" : "Hide all selected"}
                >
                  {anySelectedHidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                  {anySelectedHidden ? "Unhide" : "Hide"}
                </button>
                {!inAlbum && (
                  <button
                    type="button"
                    className="selection-bar-action"
                    onClick={() => props.onOpenAlbumPicker?.(props.selectedIds)}
                    title="Add selected items to an album"
                  >
                    <AlbumsIcon size={13} /> Add to album
                  </button>
                )}
                <button
                  type="button"
                  className="selection-bar-action"
                  onClick={() => props.onCopyTagsToFinder?.(props.selectedIds)}
                  disabled={!selectedItems.some((item) => item.tags?.length)}
                  title="Merge VistoGallery tags into each file's Finder tags. Existing Finder tags are kept."
                >
                  <TagIcon size={13} /> Tags to Finder
                </button>
                {inAlbum && (
                  <button
                    type="button"
                    className="selection-bar-action"
                    onClick={() =>
                      props.activeAlbum &&
                      library.removeFromAlbum(props.activeAlbum, props.selectedIds)
                    }
                    title="Remove selected items from this album (photos stay in the library)"
                  >
                    <MinusIcon size={13} /> Remove from album
                  </button>
                )}
                {!props.hiddenView && (
                  <button
                    type="button"
                    className="selection-bar-action"
                    onClick={() => props.onOpenBatch?.(props.selectedIds)}
                    title="Send the selected items to Batch export"
                  >
                    <BatchIcon size={13} /> Batch
                  </button>
                )}
                {!props.hiddenView && (
                  <button
                    type="button"
                    className="selection-bar-action selection-bar-action-danger"
                    onClick={() => props.onRequestDeleteItems?.(props.selectedIds)}
                    title="Move selected items to Trash"
                  >
                    <TrashIcon size={13} /> Delete
                  </button>
                )}
              </div>
            </div>
          )}
        </header>

        <div
          className="library-grid-container"
          ref={scrollRef}
          onScroll={handleGridScroll}
          onKeyDown={handleGridKeyDown}
        >
          {props.layout === "details" && (
            <div className="details-header-sticky">
              <div className="details-col details-preview-heading">Preview</div>
              {detailsHeader("Name", "name")}
              {detailsHeader("Captured", "capturedAt")}
              {detailsHeader("Kind", "kind")}
              {detailsHeader("Size", "size")}
            </div>
          )}
          {(() => {
            if (props.layout === "details") {
              return (
                <div className="gallery-grid layout-details">
                  {renderedItems.map((item: any) => (
                    <article
                      key={item.id}
                      className={tileClass(item)}
                      onContextMenu={(e: any) => {
                        concealItem(item.id);
                        props.onContextMenu(itemContextMenu(item), e);
                      }}
                    >
                      <div className="tile-select-check">
                        <input
                          type="checkbox"
                          checked={selectedIdSet.has(item.id)}
                          onChange={() => props.onToggleSelect(item.id)}
                          title={
                            selectedIdSet.has(item.id)
                              ? "Remove from selection"
                              : "Add to selection"
                          }
                          onClick={(e: any) => e.stopPropagation()}
                        />
                        <CheckIcon size={12} />
                      </div>
                      <button
                        type="button"
                        className="tile-open-button"
                        data-item-id={item.id}
                        onClick={(e) => {
                          e.currentTarget.focus();
                          handleTileClick(item, e);
                        }}
                        onDoubleClick={() => handleTileDoubleClick(item)}
                        {...holdHandlers(item.id)}
                      >
                        <span className="tile-image">
                          {item.kind === "video" ? (
                            canPlayVideoInApp(item.path, item.name) ? (
                              <VideoThumb src={assetUrl(item.path)} name={tileAlt(item)} />
                            ) : (
                              // Decoding a frame needs a playable container;
                              // fall back to the cached QuickLook thumbnail so
                              // MKV/AVI tiles never request the whole file.
                              <CachedThumbnail
                                itemId={item.id}
                                name={tileAlt(item)}
                                size={thumbnailPixels}
                              />
                            )
                          ) : item.kind === "photo" ? (
                            <CachedThumbnail
                              itemId={item.id}
                              name={tileAlt(item)}
                              size={thumbnailPixels}
                              style={draftImageStyle(draftTransforms, item.id)}
                              fallbackSrc={assetUrl(item.path)}
                            />
                          ) : (
                            <span className="raw-tile">
                              <KindBadge kind={item.kind} />
                            </span>
                          )}
                          {item.kind === "video" &&
                            canPlayVideoInApp(item.path, item.name) &&
                            props.onPlayBackground && (
                              <button
                                type="button"
                                className="tile-play-background"

                                aria-label={
                                  playingId === item.id && isPlaying
                                    ? `Pause ${tileAlt(item)}`
                                    : `Play ${tileAlt(item)} in background`
                                }

                                title={
                                  playingId === item.id && isPlaying
                                    ? "Pause"
                                    : "Play in background"
                                }

                                onClick={(event) => {
                                  event.stopPropagation();

                                  toggleBackground(item);
                                }}

                                onDoubleClick={(event) => event.stopPropagation()}

                                aria-pressed={playingId === item.id && isPlaying}
                              >
                                {playingId === item.id && isPlaying ? (
                                  <PauseIcon size={16} />
                                ) : (
                                  <PlayIcon size={16} />
                                )}
                              </button>
                            )}
                          {item.kind === "video" && (
                            <span className="video-label">
                              <PlayIcon size={10} />
                            </span>
                          )}
                          {item.kind === "raw" && (
                            <span className="format-label">
                              <KindBadge kind={item.kind} />
                            </span>
                          )}
                          {item.favorite && !masked(item) ? (
                            <span className="tile-favorite" aria-label="Favorite">
                              <HeartIcon size={11} filled />
                            </span>
                          ) : null}
                          {item.colorLabel && !masked(item) ? (
                            <span
                              className={`tile-color-label tile-color-${item.colorLabel}`}
                              aria-label={`Color label: ${item.colorLabel}`}
                              title={`Color: ${item.colorLabel}`}
                            >
                              <span className="color-dot" />
                            </span>
                          ) : null}
                        </span>
                        <span className={`tile-caption${masked(item) ? " hidden-caption" : ""}`}>
                          <b>
                            {masked(item)
                              ? "Hidden item"
                              : item.name + (showExtensions ? `.${item.extension}` : "")}
                          </b>
                          <small className="tile-date">
                            {new Date(captureDate(item)).toLocaleDateString()}
                          </small>
                          <small className="tile-kind">
                            <KindDot kind={item.kind} />
                            {item.kind === "video"
                              ? "Video"
                              : item.kind === "raw"
                                ? "RAW"
                                : "Photo"}
                          </small>
                          <small className="tile-size">{formatBytesSimple(item.size)}</small>
                        </span>
                      </button>
                    </article>
                  ))}
                  {props.items.length === 0 && emptyView()}
                </div>
              );
            }
            if (props.layout === "timeline") {
              return (
                <div className={`gallery-grid layout-timeline thumb-${thumbnailSize}`}>
                  {timelineGroups.length === 0
                    ? emptyView()
                    : visibleTimelineGroups.map(({ key, label, items, count, visibleItems }) => {
                        const allSelected =
                          items.length > 0 &&
                          items.every((item: any) => selectedIdSet.has(item.id));
                        return (
                          <React.Fragment key={key}>
                            <div className="timeline-group">
                              <div className="timeline-date-marker" aria-hidden="true">
                                <span />
                              </div>
                              <h3>{label}</h3>
                              <span className="timeline-count">
                                {count} {count === 1 ? "item" : "items"}
                              </span>
                              <button
                                type="button"
                                className="timeline-select-group"
                                aria-pressed={allSelected}
                                onClick={() => toggleTimelineGroup(items)}
                                title={`Select or deselect all ${label} items`}
                              >
                                <span className="timeline-select-box">
                                  {allSelected ? <CheckIcon size={11} /> : null}
                                </span>
                                {allSelected ? "Selected" : "Select all"}
                              </button>
                            </div>
                            {visibleItems.map((item: any) => (
                              <article
                                key={item.id}
                                className={tileClass(item)}
                                onContextMenu={(e: any) => {
                                  concealItem(item.id);
                                  props.onContextMenu(itemContextMenu(item), e);
                                }}
                              >
                                <div className="tile-select-check">
                                  <input
                                    type="checkbox"
                                    checked={selectedIdSet.has(item.id)}
                                    onChange={() => props.onToggleSelect(item.id)}
                                    title={
                                      selectedIdSet.has(item.id)
                                        ? "Remove from selection"
                                        : "Add to selection"
                                    }
                                    onClick={(e: any) => e.stopPropagation()}
                                  />
                                  <CheckIcon size={12} />
                                </div>
                                <button
                                  type="button"
                                  className="tile-open-button"
                                  data-item-id={item.id}
                                  onClick={(e) => {
                                    e.currentTarget.focus();
                                    handleTileClick(item, e);
                                  }}
                                  onDoubleClick={() => handleTileDoubleClick(item)}
                                  {...holdHandlers(item.id)}
                                >
                                  <span className="tile-image">
                                    {item.kind === "video" ? (
                                      canPlayVideoInApp(item.path, item.name) ? (
                                        <VideoThumb
                                          src={assetUrl(item.path)}
                                          name={tileAlt(item)}
                                        />
                                      ) : (
                                        <CachedThumbnail
                                          itemId={item.id}
                                          name={tileAlt(item)}
                                          size={thumbnailPixels}
                                        />
                                      )
                                    ) : item.kind === "photo" ? (
                                      <CachedThumbnail
                                        itemId={item.id}
                                        name={tileAlt(item)}
                                        size={thumbnailPixels}
                                        style={draftImageStyle(draftTransforms, item.id)}
                                        fallbackSrc={assetUrl(item.path)}
                                      />
                                    ) : (
                                      <span className="raw-tile">
                                        <KindBadge kind={item.kind} />
                                      </span>
                                    )}
                                    {item.kind === "video" &&
                                      canPlayVideoInApp(item.path, item.name) &&
                                      props.onPlayBackground && (
                                        <button
                                          type="button"
                                          className="tile-play-background"

                                          aria-label={
                                            playingId === item.id && isPlaying
                                              ? `Pause ${tileAlt(item)}`
                                              : `Play ${tileAlt(item)} in background`
                                          }

                                          title={
                                            playingId === item.id && isPlaying
                                              ? "Pause"
                                              : "Play in background"
                                          }

                                          onClick={(event) => {
                                            event.stopPropagation();

                                            toggleBackground(item);
                                          }}

                                          onDoubleClick={(event) => event.stopPropagation()}

                                          aria-pressed={playingId === item.id && isPlaying}
                                        >
                                          {playingId === item.id && isPlaying ? (
                                            <PauseIcon size={16} />
                                          ) : (
                                            <PlayIcon size={16} />
                                          )}
                                        </button>
                                      )}
                                    {item.kind === "video" && (
                                      <span className="video-label">
                                        <PlayIcon size={10} />
                                      </span>
                                    )}
                                    {item.kind === "raw" && (
                                      <span className="format-label">
                                        <KindBadge kind={item.kind} />
                                      </span>
                                    )}
                                    {item.favorite && !masked(item) ? (
                                      <span className="tile-favorite" aria-label="Favorite">
                                        <HeartIcon size={11} filled />
                                      </span>
                                    ) : null}
                                    {item.colorLabel && !masked(item) ? (
                                      <span
                                        className={`tile-color-label tile-color-${item.colorLabel}`}
                                        aria-label={`Color label: ${item.colorLabel}`}
                                        title={`Color: ${item.colorLabel}`}
                                      >
                                        <span className="color-dot" />
                                      </span>
                                    ) : null}
                                  </span>
                                  <span
                                    className={`tile-caption${masked(item) ? " hidden-caption" : ""}`}
                                  >
                                    <b>
                                      {item.name + (showExtensions ? `.${item.extension}` : "")}
                                    </b>
                                    <small className="tile-date">
                                      {new Date(captureDate(item)).toLocaleDateString()}
                                    </small>
                                    <small className="tile-kind">
                                      <KindDot kind={item.kind} />
                                      {item.kind === "video"
                                        ? "Video"
                                        : item.kind === "raw"
                                          ? "RAW"
                                          : "Photo"}
                                    </small>
                                    <small className="tile-size">
                                      {formatBytesSimple(item.size)}
                                    </small>
                                  </span>
                                </button>
                              </article>
                            ))}
                          </React.Fragment>
                        );
                      })}
                </div>
              );
            }
            return (
              <div className={`gallery-grid layout-${props.layout} thumb-${thumbnailSize}`}>
                {virtualGrid.topSpacer > 0 && (
                  <div
                    className="grid-virtual-spacer"
                    aria-hidden="true"
                    style={{ height: virtualGrid.topSpacer }}
                  />
                )}
                {virtualGrid.items.map((item: any) => (
                  <article
                    key={item.id}
                    className={tileClass(item)}
                    onContextMenu={(e: any) => {
                      concealItem(item.id);
                      props.onContextMenu(itemContextMenu(item), e);
                    }}
                  >
                    <div className="tile-select-check">
                      <input
                        type="checkbox"
                        checked={selectedIdSet.has(item.id)}
                        onChange={() => props.onToggleSelect(item.id)}
                        title={
                          selectedIdSet.has(item.id) ? "Remove from selection" : "Add to selection"
                        }
                        onClick={(e: any) => e.stopPropagation()}
                      />
                      <CheckIcon size={12} />
                    </div>
                    <button
                      type="button"
                      className="tile-open-button"
                      data-item-id={item.id}
                      onClick={(e) => {
                        e.currentTarget.focus();
                        handleTileClick(item, e);
                      }}
                      onDoubleClick={() => handleTileDoubleClick(item)}
                      {...holdHandlers(item.id)}
                    >
                      <span className="tile-image">
                        {item.kind === "video" ? (
                          canPlayVideoInApp(item.path, item.name) ? (
                            <VideoThumb src={assetUrl(item.path)} name={tileAlt(item)} />
                          ) : (
                            <CachedThumbnail
                              itemId={item.id}
                              name={tileAlt(item)}
                              size={thumbnailPixels}
                            />
                          )
                        ) : item.kind === "photo" ? (
                          <CachedThumbnail
                            itemId={item.id}
                            name={tileAlt(item)}
                            size={thumbnailPixels}
                            style={draftImageStyle(draftTransforms, item.id)}
                            fallbackSrc={assetUrl(item.path)}
                          />
                        ) : (
                          <span className="raw-tile">
                            <KindBadge kind={item.kind} />
                          </span>
                        )}
                        {item.kind === "video" &&
                          canPlayVideoInApp(item.path, item.name) &&
                          props.onPlayBackground && (
                            <button
                              type="button"
                              className="tile-play-background"

                              aria-label={
                                playingId === item.id && isPlaying
                                  ? `Pause ${tileAlt(item)}`
                                  : `Play ${tileAlt(item)} in background`
                              }

                              title={
                                playingId === item.id && isPlaying ? "Pause" : "Play in background"
                              }

                              onClick={(event) => {
                                event.stopPropagation();

                                toggleBackground(item);
                              }}

                              onDoubleClick={(event) => event.stopPropagation()}

                              aria-pressed={playingId === item.id && isPlaying}
                            >
                              {playingId === item.id && isPlaying ? (
                                <PauseIcon size={16} />
                              ) : (
                                <PlayIcon size={16} />
                              )}
                            </button>
                          )}
                        {item.kind === "video" && (
                          <span className="video-label">
                            <PlayIcon size={10} />
                          </span>
                        )}
                        {item.kind === "raw" && (
                          <span className="format-label">
                            <KindBadge kind={item.kind} />
                          </span>
                        )}
                        {item.favorite && !masked(item) ? (
                          <span className="tile-favorite" aria-label="Favorite">
                            <HeartIcon size={11} filled />
                          </span>
                        ) : null}
                        {item.colorLabel && !masked(item) ? (
                          <span
                            className={`tile-color-label tile-color-${item.colorLabel}`}
                            aria-label={`Color label: ${item.colorLabel}`}
                            title={`Color: ${item.colorLabel}`}
                          >
                            <span className="color-dot" />
                          </span>
                        ) : null}
                        {item.rating != null && item.rating > 0 && !masked(item) ? (
                          <span className="tile-rating" aria-label={`Rating: ${item.rating} stars`}>
                            {Array.from({ length: 5 }).map((_, i) => (
                              <span key={i} className={`star ${i < item.rating ? "filled" : ""}`}>
                                {"\u2605"}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </span>
                      <span className={`tile-caption${masked(item) ? " hidden-caption" : ""}`}>
                        <b>{item.name + (showExtensions ? `.${item.extension}` : "")}</b>
                        <small className="tile-date">
                          {new Date(captureDate(item)).toLocaleDateString()}
                        </small>
                        <small className="tile-kind">
                          {item.kind === "video" ? "Video" : item.kind === "raw" ? "RAW" : "Photo"}
                        </small>
                        <small className="tile-size">{formatBytesSimple(item.size)}</small>
                      </span>
                    </button>
                  </article>
                ))}
                {virtualGrid.bottomSpacer > 0 && (
                  <div
                    className="grid-virtual-spacer"
                    aria-hidden="true"
                    style={{ height: virtualGrid.bottomSpacer }}
                  />
                )}
                {props.items.length === 0 && emptyView()}
              </div>
            );
          })()}
          {!supportsGridVirtualization && renderLimit < props.items.length && (
            <div className="grid-more">
              <button type="button" className="quiet-button" onClick={loadMore}>
                Show more loaded items · {(props.items.length - renderLimit).toLocaleString()}
              </button>
            </div>
          )}
        </div>
      </section>
      {props.showInspector && (
        <PanelResizer
          side="right"
          width={inspectorWidth}
          min={240}
          max={() =>
            Math.min(
              480,
              Math.max(240, (inspectorRef.current?.clientWidth ?? window.innerWidth) - 360),
            )
          }
          cssVar="--inspector-width"
          targetRef={inspectorRef}
          onCommit={(next) => void updateSettings("inspectorWidth", next)}
          defaultWidth={300}
          label="Resize inspector"
        />
      )}
      {props.showInspector && (
        <aside className="photo-inspector">
          {props.inspectedId &&
          (props.hiddenView ? library.hiddenItems : library.items).find(
            (i: any) => i.id === props.inspectedId,
          ) ? (
            (() => {
              const sel = (props.hiddenView ? library.hiddenItems : library.items).find(
                (i: any) => i.id === props.inspectedId,
              );
              if (!sel) return null;
              // Inspection is independent of selection: the Inspector always
              // shows the inspected item, even when a larger multi-selection
              // exists (already-selected items stay inspectable).
              const isSelected = selectedIdSet.has(sel.id);
              return (
                <>
                  <div className="inspector-top">
                    <div>
                      <small>
                        {props.selectedIds.length > 1 && isSelected
                          ? "SELECTED · INSPECTING"
                          : "INSPECTING"}
                      </small>
                      <h2 title={masked(sel) ? "Hidden item" : sel.name}>
                        {masked(sel) ? "Hidden item" : sel.name}
                      </h2>
                      {props.selectedIds.length > 1 && (
                        <span className="inspector-selection-note">
                          {props.selectedIds.length} selected · inspection independent
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="inspector-close-btn"
                      onClick={props.onToggleInspector}
                      title="Close Inspector (⌥⌘I)"
                    >
                      ×
                    </button>
                  </div>
                  <span className="inspector-image-wrapper">
                    <button
                      className={`inspector-image${masked(sel) ? " hidden-obscured" : ""}`}
                      type="button"
                      aria-label={
                        masked(sel)
                          ? "Hold to reveal preview; double-click to open"
                          : `Open ${sel.name} in viewer`
                      }
                      onDoubleClick={() => props.onOpenViewer(sel.id)}
                      title={
                        masked(sel)
                          ? "Hold to reveal preview · double-click to open"
                          : "Double-click to open in viewer"
                      }
                      {...holdHandlers(sel.id)}
                    >
                      {sel.kind === "photo" ? (
                        <img
                          src={assetUrl(sel.path)}
                          alt={tileAlt(sel)}
                          style={draftImageStyle(draftTransforms, sel.id)}
                        />
                      ) : sel.kind === "video" ? (
                        <span className="inspector-video-preview">
                          <video
                            src={assetUrl(sel.path)}
                            autoPlay
                            muted
                            loop
                            playsInline
                            preload="metadata"
                            aria-label={`${tileAlt(sel)} preview`}
                          />
                        </span>
                      ) : (
                        <span className="raw-tile">
                          <KindBadge kind={sel.kind} />
                        </span>
                      )}
                      <span>Double-click to view</span>
                      <span className="inspector-type-badge">
                        {sel.kind === "video" ? "Video" : sel.kind === "raw" ? "RAW" : "Photo"}
                      </span>
                    </button>
                    {sel.kind === "video" && props.onPlayBackground && (
                      <button
                        type="button"
                        className="inspector-video-play"
                        aria-label={
                          playingId === sel.id && isPlaying
                            ? `Pause ${tileAlt(sel)}`
                            : `Play ${tileAlt(sel)} in background`
                        }
                        aria-pressed={playingId === sel.id && isPlaying}
                        title={playingId === sel.id && isPlaying ? "Pause" : "Play in background"}
                        onClick={() => toggleBackground(sel)}
                      >
                        {playingId === sel.id && isPlaying ? (
                          <PauseIcon size={20} />
                        ) : (
                          <PlayIcon size={20} />
                        )}
                      </button>
                    )}
                  </span>
                  <div className="inspector-actions">
                    {sel.kind === "video" ? (
                      <button
                        className="inspector-action primary"
                        onClick={() => toggleBackground(sel)}
                        title={
                          playingId === sel.id && isPlaying
                            ? "Pause — the top bar controls the session"
                            : "Play in background — keep browsing; the top bar shows playback"
                        }
                        aria-pressed={playingId === sel.id && isPlaying}
                      >
                        {playingId === sel.id && isPlaying ? (
                          <PauseIcon size={14} />
                        ) : (
                          <PlayIcon size={14} />
                        )}
                        <span>{playingId === sel.id && isPlaying ? "Pause" : "Play"}</span>
                      </button>
                    ) : (
                      <button
                        className="inspector-action primary"
                        onClick={() => props.onOpenViewer(sel.id)}
                        title="View item"
                      >
                        <PlayIcon size={14} />
                        <span>View</span>
                      </button>
                    )}
                    <button
                      className={`inspector-action ${sel.favorite ? "favorite active" : ""}`}
                      onClick={() => props.onToggleFavorite(props.inspectedId as string)}
                      title={sel.favorite ? "Unfavorite" : "Favorite"}
                    >
                      <HeartIcon size={14} filled={!!sel.favorite} />
                      <span>{sel.favorite ? "Unfavorite" : "Favorite"}</span>
                    </button>
                    <button
                      className="inspector-action"
                      onClick={() => props.onToggleHidden(props.inspectedId as string)}
                      title={sel.hidden ? "Unhide" : "Hide"}
                    >
                      {sel.hidden ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                      <span>{sel.hidden ? "Unhide" : "Hide"}</span>
                    </button>
                    <button
                      className={`inspector-action ${isSelected ? "active" : ""}`}
                      onClick={() => props.onToggleSelect(sel.id)}
                      title={isSelected ? "Remove from selection" : "Add to selection"}
                    >
                      {isSelected ? <CheckIcon size={14} /> : <PlusIcon size={14} />}
                      <span>{isSelected ? "Selected" : "Select"}</span>
                    </button>
                  </div>
                  <div className="inspector-section">
                    <div className="inspector-section-head">
                      <b>File Info</b>
                    </div>
                    <div className="info-card">
                      {masked(sel) ? (
                        <div className="inspector-hidden-note">
                          Hold the preview to reveal file details.
                        </div>
                      ) : (
                        <>
                          <div className="info-row">
                            <span className="info-label">Name</span>
                            <span className="info-value" title={sel.name}>
                              {sel.name}
                            </span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">Kind</span>
                            <span className="info-value">
                              <KindBadge kind={sel.kind} />
                            </span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">Format</span>
                            <span className="info-value">{sel.extension.toUpperCase()}</span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">Dimensions</span>
                            <span className="info-value">
                              {sel.width && sel.height ? `${sel.width} × ${sel.height}` : "Unknown"}
                            </span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">Size</span>
                            <span className="info-value">{formatBytesSimple(sel.size)}</span>
                          </div>
                          {sel.camera && (
                            <div className="info-row">
                              <span className="info-label">Camera</span>
                              <span className="info-value" title={sel.camera}>
                                {sel.camera}
                              </span>
                            </div>
                          )}
                          {sel.lens && (
                            <div className="info-row">
                              <span className="info-label">Lens</span>
                              <span className="info-value" title={sel.lens}>
                                {sel.lens}
                              </span>
                            </div>
                          )}
                          {sel.capturedAt && (
                            <div className="info-row">
                              <span className="info-label">Captured</span>
                              <span className="info-value">
                                {new Date(sel.capturedAt).toLocaleString()}
                              </span>
                            </div>
                          )}
                          <div className="info-row">
                            <span className="info-label">Modified</span>
                            <span className="info-value">
                              {new Date(sel.modifiedAt).toLocaleString()}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  {!masked(sel) && (
                    <div className="inspector-tags">
                      <div className="inspector-section-head">
                        <b>App Tags</b>
                      </div>
                      <div className="tags-list">
                        {sel.tags?.map((tag: string) => (
                          <span className="app-tag" key={tag}>
                            {tag}
                            <button
                              type="button"
                              onClick={() =>
                                props.onUpdateTags(
                                  props.inspectedId as string,
                                  (sel.tags || []).filter((t: string) => t !== tag),
                                )
                              }
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                      <input
                        className="tag-input"
                        aria-label="Add tag"
                        placeholder="Add tag and press Enter…"
                        onKeyDown={(e: any) => {
                          if (e.key === "Enter" && e.currentTarget.value.trim()) {
                            const newTag = e.currentTarget.value.trim();
                            const currentTags = sel.tags || [];
                            if (!currentTags.includes(newTag)) {
                              props.onUpdateTags(props.inspectedId as string, [
                                ...currentTags,
                                newTag,
                              ]);
                            }
                            e.currentTarget.value = "";
                          }
                        }}
                      />
                    </div>
                  )}
                </>
              );
            })()
          ) : (
            <div className="inspector-empty-state">
              <div className="inspector-top">
                <div>
                  <small>INSPECTOR</small>
                  <h2>No Inspection</h2>
                </div>
                <button
                  type="button"
                  className="inspector-close-btn"
                  onClick={props.onToggleInspector}
                  title="Close Inspector"
                >
                  ×
                </button>
              </div>
              <div className="inspector-empty-placeholder">
                <span className="inspector-empty-icon">
                  <DetailsIcon size={26} />
                </span>
                <p>
                  Single-click a photo or video to inspect its details. Selection is separate — use
                  the checkbox or + to multi-select.
                </p>
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

export default LibraryScreen;
