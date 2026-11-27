import { DateJump } from "./timeline/DateJump";
import { cachedItem, groupLoaded, scopedPages, timelineKey } from "./timeline/monthCache";
import { MonthContinuation } from "./timeline/MonthContinuation";
import type { CSSProperties } from "react";
import React, { useState, useMemo, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { useKeyboard } from "../engine/hooks/useKeyboard";
import {
  AlbumsIcon,
  ChevronLeftIcon,
  BatchIcon,
  CheckIcon,
  ChevronDownIcon,
  DetailsIcon,
  FullscreenIcon,
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
import { LivePhotoThumb } from "../design/components/LivePhotoThumb";
import { PanelResizer } from "../design/components/PanelResizer";
import { KindBadge, KindDot } from "../design/components/KindBadge";
import { AlbumPhotoStack } from "../design/components/AlbumPhotoStack";
import VideoThumb, { VideoPoster } from "../design/components/VideoThumb";
import { useDraftTransforms } from "../engine/stores/useEditStore";
import { draftImageStyle } from "../engine/utils/draftImage";
import { LibrarySearch } from "./library/LibrarySearch";
import {
  calculateVirtualGridWindow,
  computeVirtualGridLayout,
  restoreScrollOffset,
} from "./library/scrollRestore";
export { calculateVirtualGridWindow };
import { toDateInputValue } from "../engine/utils/dateRange";
import {
  useLibraryStore,
  libraryViewKey,
  currentLibraryFilter,
  hiddenPageFilter,
} from "../engine/stores/useLibraryStore";
import {
  groupYears,
  isMonthCollapsed,
  monthsFromItems,
  monthYear,
  useTimelineCollapse,
  useTimelineMonths,
} from "./timeline/timelineMonths";
import { usePlaybackStore } from "../engine/stores/usePlaybackStore";
import { FilterDropdown } from "../design/components/FilterDropdown";
import { ActiveRefinements } from "../design/components/ActiveRefinements";
import SplitButton from "../design/components/SplitButton";
import {
  useSettingsStore,
  useThumbnailSize,
  useInspectorWidth,
} from "../engine/stores/useSettingsStore";
import { tauri } from "../engine/commands/tauri";
import { formatBytesSimple, canPlayVideoInApp } from "../engine/utils/mediaTypes";
import type { MediaItem, Filter } from "../engine/types/media";
import type { LibraryFolder } from "../engine/types/commands";
import { formatItemDate, monthLabel } from "../engine/utils/mediaDate";
import { displayFileName } from "../engine/utils/fileName";
import { livePhotoMotionMap, livePhotoMotionSrc } from "../engine/utils/livePhotos";
import { MiddleTruncate } from "../design/components/MiddleTruncate";
import { buildItemContextMenu } from "../engine/utils/itemContextMenu";
import { LibraryInspector } from "./library/LibraryInspector";
import type { LibraryScreenProps } from "./library/types";
const GALLERY_PAGE_SIZE = 180;
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
/**
 * The heading above the grid.
 *
 * A Smart Album is a saved filter, not a media-kind tab, so its own name wins:
 * rating, tag and colour definitions would otherwise all read "All Media" even
 * though the grid is filtered.
 */
export function libraryHeading(
  hiddenView: boolean | undefined,
  smartAlbumName: string | null,
  filter: string,
): string {
  if (hiddenView) return "Hidden";
  if (smartAlbumName) return smartAlbumName;
  return filter === "All" ? "All Media" : filter;
}
import { ListRowMeta } from "./library/ListRowMeta";
function LibraryScreen(props: LibraryScreenProps) {
  const library = useLibraryStore();
  const inspectedItem =
    props.showInspector && props.inspectedId
      ? ((props.hiddenView ? library.hiddenItems : library.items).find(
          (item) => item.id === props.inspectedId,
        ) ?? cachedItem(library, !!props.hiddenView, props.inspectedId))
      : undefined;
  const playingId = usePlaybackStore((state) => state.itemId);
  const isPlaying = usePlaybackStore((state) => state.playing);
  const [copiedPathFor, setCopiedPathFor] = useState<string | null>(null);
  const copyPathTimeoutRef = useRef<number | null>(null);
  const copyItemPath = useCallback((path: string, itemId: string) => {
    if (copyPathTimeoutRef.current) window.clearTimeout(copyPathTimeoutRef.current);
    void navigator.clipboard.writeText(path).then(() => {
      setCopiedPathFor(itemId);
      copyPathTimeoutRef.current = window.setTimeout(() => {
        setCopiedPathFor((current) => (current === itemId ? null : current));
      }, 1500);
    });
  }, []);
  useEffect(
    () => () => {
      if (copyPathTimeoutRef.current) window.clearTimeout(copyPathTimeoutRef.current);
    },
    [],
  );
  /** In sync with the top bar: starts the item, or toggles its session. */
  const toggleBackground = (item: MediaItem) => {
    if (!item) return;
    if (usePlaybackStore.getState().itemId === item.id) {
      usePlaybackStore.getState().toggle();
      return;
    }
    // Every video plays in the background session, whatever its container: the
    // background host is the same player component and prepares (losslessly
    // remuxes) an unplayable file before it starts, exactly like the full player.
    // Opening the player screen for one container instead made the same button
    // do two different things depending on the file.
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
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false);
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
  const livePhotoMotionByItemId = useMemo(() => livePhotoMotionMap(props.items), [props.items]);
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
  const veiled = Boolean(props.hiddenView) && props.veilHidden !== false;
  useEffect(() => {
    if (!veiled) return;
    // A pointer released outside the tile still ends the reveal. Window blur
    // covers alt-tab, which should never leave hidden media exposed.
    window.addEventListener("pointerup", concealAll);
    window.addEventListener("blur", concealAll);
    return () => {
      window.removeEventListener("pointerup", concealAll);
      window.removeEventListener("blur", concealAll);
    };
  }, [veiled, concealAll]);
  const masked = (item: MediaItem) => veiled && !revealedIds.has(item.id);
  const tileAlt = (item: MediaItem) => (masked(item) ? "Hidden item" : item.name);
  const holdHandlers = (id: string) =>
    veiled
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
    ? props.albums?.find((album) => album.id === props.activeAlbum)
    : null;
  const activeAlbumName = props.activeAlbum ? (activeAlbumRecord?.name ?? "Album") : null;
  // A Smart Album is a saved filter, not a media-kind tab, so its name is the
  // only accurate heading: rating/tag/colour definitions all open as "All
  // Media" otherwise.
  const activeSmartAlbumName =
    library.smartAlbums.find((album) => album.id === library.activeSmartAlbum)?.name ?? null;
  const inAlbum = Boolean(props.activeAlbum);
  const activeAlbumItems = useMemo(
    () =>
      props.activeAlbum
        ? (library.albumItems?.[props.activeAlbum] ??
          library.items.filter(
            (item) => item.albumIds?.includes(props.activeAlbum as string) && !item.hidden,
          ))
        : [],
    [library.items, library.albumItems, props.activeAlbum],
  );
  const activeAlbumPhotos = useMemo(
    () =>
      activeAlbumItems.filter((item) => item.kind === "photo" || item.kind === "video").slice(0, 3),
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
      (item) => item.path === library.activeSource || item.path.startsWith(prefix),
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
      if (item.kind === "photo" && !item.isAnimated) counts.Photos += 1;
      else if (item.kind === "video") counts.Videos += 1;
      else if (item.kind === "raw") counts.RAW += 1;
      // Animated files keep their own count; Photos is still images only.
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
        library.tagsFilter.length > 0 ||
        props.minRating !== null ||
        props.colorLabelFilter ||
        props.dateFrom != null ||
        props.dateTo != null,
      );
  const clearRefinements = () => {
    if (props.hiddenView) library.clearHiddenFilters();
    else library.clearFilters();
  };
  // The date chip needs a short, self-describing label because it is the only
  // place the range is shown once the Filters panel closes.
  const dateFilterLabel = (() => {
    const from = toDateInputValue(props.dateFrom);
    const to = toDateInputValue(props.dateTo);
    if (from && to) return `${from} – ${to}`;
    if (from) return `From ${from}`;
    if (to) return `To ${to}`;
    return "";
  })();

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
        <span>
          {albumEmpty ? (
            <AlbumsIcon size={30} />
          ) : props.hasItems === false ? (
            <ImageOffIcon size={28} />
          ) : (
            <SearchIcon size={28} />
          )}
        </span>
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
              : "Nothing in this view matches your search or filters."}
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

  // Placeholders shown while the first page for this view loads, so a fresh
  // filter or folder never flashes the empty state. Matches the grid tile's
  // footprint; the details layout gets a row-shaped variant.
  const skeletonView = () => (
    <>
      <span className="visually-hidden" role="status">
        Loading library…
      </span>
      {props.layout === "details"
        ? Array.from({ length: 10 }, (_, index) => (
            <span key={index} className="library-skeleton-row" aria-hidden="true" />
          ))
        : Array.from({ length: 12 }, (_, index) => (
            <span key={index} className="library-skeleton-tile" aria-hidden="true" />
          ))}
    </>
  );

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
  // First page for this view hasn't arrived yet: show placeholders rather
  // than flash the "empty library" copy while the query is in flight.
  const awaitingFirstPage = props.hiddenView
    ? library.hiddenLoading
    : library.loadedViewKey !== viewKey;
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

  const virtualMetricsRef = useRef<{ columns: number; rowStride: number; itemIds: string[] }>({
    columns: 0,
    rowStride: 0,
    itemIds: [],
  });
  const inspectedIdRef = useRef(props.inspectedId);
  inspectedIdRef.current = props.inspectedId;

  // Restore the scroll offset saved for this view, refilling the same item
  // depth first so the grid is tall enough to reach the remembered row.
  // With no saved offset, start at the top and reveal the inspected item.
  useEffect(() => {
    const dataReady = props.hiddenView || library.loadedViewKey === viewKey;
    if (!dataReady || restoringScrollRef.current) return;
    if (restoredScrollKeyRef.current === scrollKey) return;
    restoredScrollKeyRef.current = scrollKey;

    const el = scrollRef.current;
    const saved = rememberedScroll.get(scrollKey);
    if (!el) return;

    setRenderLimit(Math.max(GALLERY_PAGE_SIZE, saved?.renderLimit ?? 0));

    const jumpToSavedOffset = () =>
      restoreScrollOffset(
        el,
        saved?.scrollTop ?? 0,
        inspectedIdRef.current,
        restoringScrollRef,
        virtualMetricsRef.current,
      );

    const refillDepth = async () => {
      if (props.layout === "timeline" || props.hiddenView || !saved) return;
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
  }, [library.loadedViewKey, props.hiddenView, props.layout, scrollKey, viewKey]);

  const loadMore = () => {
    if (props.hiddenView) {
      // The Hidden gallery is its own paginated query (`get_hidden_items`).
      // Use the same near-bottom trigger as the main grid, but route to the
      // hidden pager instead of the library one. The Timeline and Details
      // layouts still render a local window, so grow it before asking for
      // another page.
      const state = useLibraryStore.getState();
      const nextRenderLimit = Math.min(renderLimit + GALLERY_PAGE_SIZE, props.items.length);
      setRenderLimit(nextRenderLimit);
      if (!state.hiddenLoading && state.hiddenHasMore && nextRenderLimit >= props.items.length) {
        void state.loadMoreHiddenItems();
      }
      return;
    }
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
    if (props.layout !== "timeline" && el.scrollHeight - el.scrollTop - el.clientHeight < 800)
      loadMore();
  };
  // Destructuring keeps the callback's dependency list to the one prop it uses.
  const { onInspectItem } = props;
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
      if (itemId) onInspectItem?.(itemId);
    },
    [onInspectItem],
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
      return { items: renderedItems, topSpacer: 0, bottomSpacer: 0, columns: 0, rowStride: 0 };
    }

    const { columns, rowStride, gap } = computeVirtualGridLayout({
      layout: props.layout,
      thumbnailSize,
      showInspector: props.showInspector,
      viewportWidth: gridViewport.width,
      measuredTileHeight,
    });
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
      columns,
      rowStride,
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
  virtualMetricsRef.current = {
    columns: virtualGrid.columns,
    rowStride: virtualGrid.rowStride,
    itemIds: renderedItems.map((item) => item.id),
  };

  useLayoutEffect(() => {
    if (!supportsGridVirtualization) return;
    const tile = scrollRef.current?.querySelector<HTMLElement>(
      ".gallery-grid.layout-grid .gallery-tile, .gallery-grid.layout-overview .gallery-tile",
    );
    const height = tile?.getBoundingClientRect().height;
    if (height && (measuredTileHeight === null || Math.abs(measuredTileHeight - height) > 1)) {
      setMeasuredTileHeight(height);
    }
  }, [
    props.layout,
    thumbnailSize,
    gridViewport.width,
    supportsGridVirtualization,
    measuredTileHeight,
  ]);
  const selectedIdSet = useMemo(() => new Set(props.selectedIds), [props.selectedIds]);

  // Timeline months come from the catalog, so a month's count and its
  // Select all describe the whole month, not just the loaded pages. Hidden is
  // its own scope: its months, counts and selection use the hidden filter.
  const timelineActive = props.layout === "timeline";
  const catalogTimeline = timelineActive;
  const timelineFilter = props.hiddenView
    ? hiddenPageFilter(library)
    : currentLibraryFilter(library);
  const timelineRefreshKey = timelineKey(library, !!props.hiddenView);
  useEffect(() => {
    const state = useLibraryStore.getState();
    if (
      state.timelineCache &&
      (!timelineActive || state.timelineCache.view !== timelineRefreshKey)
    ) {
      useLibraryStore.setState({ timelineCache: undefined });
      state.refreshDerived();
    }
  }, [timelineActive, timelineRefreshKey]);
  const catalogMonths = useTimelineMonths(catalogTimeline, timelineFilter, timelineRefreshKey);
  const pages = scopedPages(library, !!props.hiddenView);
  const timelineMonths = useMemo(
    () => (timelineActive ? (catalogMonths ?? monthsFromItems(props.items)) : []),
    [timelineActive, catalogMonths, props.items],
  );
  const timelineCollapse = useTimelineCollapse();
  const newestTimelineYear = timelineMonths[0] ? monthYear(timelineMonths[0].key) : null;
  const loadedByMonth = useMemo(
    () => groupLoaded(timelineActive ? props.items : [], pages),
    [timelineActive, props.items, pages],
  );
  const visibleTimelineGroups = useMemo(
    () =>
      timelineMonths.map((month) => ({
        ...month,
        label: monthLabel(month.key),
        visibleItems: loadedByMonth.get(month.key) ?? [],
        collapsed: isMonthCollapsed(timelineCollapse.overrides, month.key, newestTimelineYear),
      })),
    [timelineMonths, loadedByMonth, timelineCollapse.overrides, newestTimelineYear],
  );
  const yearsByKey = useMemo(() => groupYears(visibleTimelineGroups), [visibleTimelineGroups]);
  const timelineYears = useMemo(() => [...yearsByKey.values()], [yearsByKey]);

  // The Timeline is a chronology: it always reads newest first by date.
  const { sortBy: librarySortBy, sortOrder: librarySortOrder, setSort: setLibrarySort } = library;
  useEffect(() => {
    if (!catalogTimeline) return;
    if (librarySortBy !== "capturedAt" || librarySortOrder !== "desc") {
      setLibrarySort("capturedAt", "desc");
    }
  }, [catalogTimeline, librarySortBy, librarySortOrder, setLibrarySort]);

  const sortDetailsBy = (sortBy: typeof library.sortBy) => {
    library.setSort(
      sortBy,
      library.sortBy === sortBy && library.sortOrder === "asc" ? "desc" : "asc",
    );
  };
  const detailsHeader = (label: string, sortBy?: typeof library.sortBy, columnClass?: string) => (
    <div
      className={`details-col list-view-head-cell${columnClass ? ` ${columnClass}` : ""}`}
      role="columnheader"
      aria-sort={
        sortBy
          ? library.sortBy === sortBy
            ? library.sortOrder === "asc"
              ? "ascending"
              : "descending"
            : "none"
          : undefined
      }
    >
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
  // Ids of every item in a month, fetched once per view and catalog state.
  const monthIdsRef = useRef<{ view: string; ids: Map<string, string[]> }>({
    view: "",
    ids: new Map(),
  });
  const monthIdsView = timelineRefreshKey;
  if (monthIdsRef.current.view !== monthIdsView) {
    monthIdsRef.current = { view: monthIdsView, ids: new Map() };
  }
  const knownMonthIds = (month: { key: string; count: number }): string[] | null => {
    const fetched = monthIdsRef.current.ids.get(month.key);
    if (fetched) return fetched;
    const loaded = loadedByMonth.get(month.key) ?? [];
    return loaded.length >= month.count ? loaded.map((item) => item.id) : null;
  };
  const monthAllSelected = (month: { key: string; count: number }) => {
    const ids = knownMonthIds(month);
    return !!ids && ids.length > 0 && ids.every((id) => selectedIdSet.has(id));
  };
  const toggleTimelineMonth = async (month: { key: string; count: number }) => {
    let ids = knownMonthIds(month);
    if (!ids) {
      try {
        const state = useLibraryStore.getState();
        ids = await tauri.library.getMatchingIds({
          ...(props.hiddenView ? hiddenPageFilter(state) : currentLibraryFilter(state)),
          month: month.key,
          limit: undefined,
          cursor: undefined,
        });
      } catch {
        ids = (loadedByMonth.get(month.key) ?? []).map((item) => item.id);
      }
      if (monthIdsRef.current.view !== monthIdsView) return;
      monthIdsRef.current.ids.set(month.key, ids);
    }
    const selected = useLibraryStore.getState().selectedIds;
    const monthIds = new Set(ids);
    const allSelected = ids.length > 0 && ids.every((id) => selected.includes(id));
    props.onSetSelection?.(
      allSelected
        ? selected.filter((id: string) => !monthIds.has(id))
        : [...new Set([...selected, ...ids])],
    );
  };
  const toggleTimelineCollapse = (key: string, collapsed: boolean, everything: boolean) => {
    if (everything) {
      timelineCollapse.setAll(
        timelineYears.map(({ year }) => year),
        !collapsed,
      );
    } else {
      timelineCollapse.setMonth(key, !collapsed);
    }
  };
  const toggleTimelineYear = (year: string, everything: boolean) => {
    const allCollapsed = yearsByKey.get(year)?.collapsed;
    if (everything) {
      timelineCollapse.setAll(
        timelineYears.map((entry) => entry.year),
        !allCollapsed,
      );
    } else {
      timelineCollapse.setYear(year, !allCollapsed);
    }
  };
  const jumpToTimelineMonth = (key: string, toYear = false) => {
    timelineCollapse.setMonth(key, false);
    // A year jump lands on the year's heading when there is one.
    const scroll = () =>
      (
        (toYear && document.getElementById(`timeline-year-${monthYear(key)}`)) ||
        document.getElementById(`timeline-month-${key}`)
      )?.scrollIntoView({ block: "start", behavior: "auto" });
    window.requestAnimationFrame(() => window.requestAnimationFrame(scroll));
  };

  const lastClickedRef = useRef<string | null>(null);

  // Interaction contract:
  //  - plain single click → inspect the item (Inspector follows; selection untouched)
  //  - shift-click → range-select from the last clicked tile
  //  - Cmd/Ctrl-click → toggle selection membership (inspection untouched)
  //  - double click → inspect + open the viewer on exactly that item
  //  - checkbox → toggle selection membership only
  const handleTileClick = (item: MediaItem, e: React.MouseEvent) => {
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

  // Keep activation on the tile rather than only on the transparent focus
  // button. Some tile children establish their own stacking context, so
  // relying on the overlay made double-click delivery unreliable.
  const handleTileActivate = (item: MediaItem, e: React.MouseEvent<HTMLElement>) => {
    if (e.type === "click") {
      // Preserve keyboard navigation after clicking the visible thumbnail.
      (e.currentTarget.querySelector(".tile-open-button") as HTMLButtonElement | null)?.focus();
      handleTileClick(item, e);
      return;
    }
    lastClickedRef.current = item.id;
    props.onInspectItem?.(item.id);
    props.onOpenViewer?.(item.id);
  };

  const tileActivationHandlers = (item: MediaItem) => ({
    onClick: (e: React.MouseEvent<HTMLElement>) => handleTileActivate(item, e),
    onDoubleClick: (e: React.MouseEvent<HTMLElement>) => handleTileActivate(item, e),
  });

  const tileClass = (item: MediaItem) =>
    `gallery-tile${props.layout === "details" ? " list-view-row" : ""}${
      props.inspectedId === item.id ? " inspected" : ""
    }${selectedIdSet.has(item.id) ? " selected" : ""}${item.favorite ? " is-favorite" : ""}${
      masked(item) ? " hidden-obscured" : ""
    }`;

  // Right-clicking a photo is the most direct place to manage its album
  // membership. The picker itself carries the album list and search. The menu
  // is shared with the viewer, so the two surfaces cannot drift apart.
  const itemContextMenu = (item: MediaItem) =>
    buildItemContextMenu(item, {
      onOpen: (id) => props.onOpenViewer(id),
      onPlayBackground: props.onPlayBackground ? () => toggleBackground(item) : undefined,
      onEdit: (target) => props.onOpenEdit?.(target),
      onCopyTagsToFinder: (ids) => props.onCopyTagsToFinder?.(ids),
      onOpenAlbumPicker: (ids) => props.onOpenAlbumPicker?.(ids),
      onCreateAlbum: (ids) => props.onCreateAlbum?.(ids),
      activeAlbum: props.activeAlbum,
      onRequestRemoveFromAlbum: (albumId, ids) => props.onRequestRemoveFromAlbum?.(albumId, ids),
      onToggleFavorite: (id) => props.onToggleFavorite(id),
      onSetFavorite: (ids, favorite) => props.onSetFavoriteForIds(ids, favorite),
      onSetHidden: (ids, hidden) => props.onSetHiddenForIds(ids, hidden),
      selection: selectedItems,
      onSetRating: (ids, rating) => props.onSetRatingForIds?.(ids, rating),
      onSetColorLabel: (ids, label) => props.onSetColorLabelForIds?.(ids, label),
      onToggleHidden: (id) => props.onToggleHidden(id),
      onRequestDelete: (ids) => props.onRequestDeleteItems?.(ids),
    });

  // Batch actions live in the contextual selection bar, so resolve the
  // selected items once and derive the toggled labels from them.
  const selectedItems = useMemo(() => {
    if (!props.selectedIds.length) return [];
    const ids = new Set(props.selectedIds);
    const pool = props.hiddenView ? library.hiddenItems : library.items;
    const selected = pool.filter((item) => ids.delete(item.id));
    if (ids.size > 0) {
      selected.push(...props.items.filter((item) => ids.delete(item.id)));
    }
    if (timelineActive && ids.size)
      for (const group of loadedByMonth.values())
        selected.push(...group.filter((item) => ids.delete(item.id)));
    return selected;
  }, [
    props.selectedIds,
    props.hiddenView,
    props.items,
    library.items,
    library.hiddenItems,
    timelineActive,
    loadedByMonth,
  ]);
  const anySelectedFavorite = selectedItems.some((i) => i.favorite);
  const anySelectedHidden = selectedItems.some((i) => i.hidden);
  // Play on a video-only selection opens the player; anything with a photo
  // starts a slideshow. The label follows the action so it is never a surprise.
  const selectionPlaysInViewer =
    selectedItems.length > 0 && selectedItems.every((i) => i.kind === "video");
  const hasCompletePhotoSelection =
    selectedItems.length === props.selectedIds.length &&
    selectedItems.every((item) => item.kind === "photo");
  const selectionCount = props.selectedIds.length.toLocaleString();
  const selectionSummary = hasCompletePhotoSelection
    ? `${selectionCount} ${props.selectedIds.length === 1 ? "photo" : "photos"} selected`
    : `${selectionCount} selected`;
  // Select-all now lives in the selection bar and is scoped to the items the
  // screen is actually showing (including the Hidden and album views).
  const allVisibleSelected =
    props.items.length > 0 && props.items.every((item) => selectedIdSet.has(item.id));
  const toggleSelectAllVisible = () => {
    props.onSetSelection?.(allVisibleSelected ? [] : props.items.map((item) => item.id));
  };

  const searchInHeading = !inAlbum && !props.hiddenView;
  const searchField = (
    <LibrarySearch
      searchInputRef={props.searchInputRef}
      hiddenView={props.hiddenView}
      query={props.query}
      onChangeQuery={props.onChangeQuery}
    />
  );

  return (
    <div
      ref={inspectorRef}
      className={`library-layout ${props.showInspector ? "with-inspector" : ""}`}
      style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}
    >
      <section className="library-center">
        <header className={`library-header${searchInHeading ? " library-header-with-search" : ""}`}>
          {inAlbum ? (
            <header className="page-heading album-detail-top">
              <div className="album-detail-head">
                <button
                  className="album-back-button"
                  type="button"
                  onClick={() => props.onOpenAlbums?.()}
                  aria-label="All albums"
                  title="All albums"
                >
                  <ChevronLeftIcon size={18} strokeWidth={2.1} />
                </button>
                <div className={`album-detail-cover${activeAlbumPhotos.length ? "" : " is-empty"}`}>
                  {activeAlbumPhotos.length ? (
                    <AlbumPhotoStack photos={activeAlbumPhotos} albumItems={activeAlbumItems} />
                  ) : (
                    <AlbumsIcon size={22} />
                  )}
                </div>
                <div className="album-detail-copy">
                  <h1>
                    <span className="album-detail-name">{activeAlbumName}</span>
                    <span className="album-count-inline">
                      {activeAlbumCount.toLocaleString()}{" "}
                      {activeAlbumCount === 1 ? "item" : "items"}
                    </span>
                  </h1>
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
            </header>
          ) : (
            <header className="page-heading">
              <div className="header-left">
                <h1>{libraryHeading(props.hiddenView, activeSmartAlbumName, props.filter)}</h1>
                {/* The hidden-view note lives in the heading instead of a
                    banner row so the sticky header stays short. When nothing is
                    hidden the empty state already says the same thing. */}
                {props.hiddenView && props.items.length > 0 && (
                  <p className="page-subtitle">
                    Hidden from the gallery only — files stay on disk at their original paths and
                    are not encrypted.
                  </p>
                )}
              </div>
              {searchInHeading && <div className="library-search-row">{searchField}</div>}
              <div className="header-actions">
                {props.hiddenView && props.hiddenHeaderAction}
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
                    <SplitButton
                      label="Add folder"
                      icon={FolderIcon}
                      onClick={() => props.onImportFolder?.()}
                      disabled={props.busy}
                      menuLabel="More import options"
                      items={[
                        {
                          key: "files",
                          label: "Add files…",
                          icon: PlusIcon,
                          title: "Add files (⌘I)",
                          onClick: () => props.onImportFiles?.(),
                        },
                      ]}
                    />
                  </>
                )}
              </div>
            </header>
          )}

          <div className={`collection-toolbar${viewOptionsOpen ? " options-open" : ""}`}>
            {!searchInHeading && searchField}
            <div className="toolbar-right">
              <div className="toolbar-actions">
                {/* An album already has a Play button in its header. */}
                {!props.activeAlbum && (
                  <button
                    className={`toolbar-button slideshow-action${props.hiddenView ? "" : " wide-library-action"}`}
                    type="button"
                    onClick={() => props.onPlaySlideshow?.(props.selectedIds)}
                    disabled={props.busy || props.items.length === 0}
                    title="Play the current view as a slideshow"
                    aria-label="Play slideshow"
                  >
                    <PlayIcon size={14} />
                    <span className="slideshow-label">Slideshow</span>
                  </button>
                )}
                {/* An album already has Add Items in its header. */}
                {!props.hiddenView && !inAlbum && (
                  <button
                    className="toolbar-button wide-library-action"
                    type="button"
                    aria-label="New album"
                    onClick={() => props.onCreateAlbum?.()}
                    title="New album"
                  >
                    <PlusIcon size={14} /> New album
                  </button>
                )}
                {!props.hiddenView && !inAlbum && (
                  <div className="compact-library-actions">
                    <SplitButton
                      label="Slideshow"
                      icon={PlayIcon}
                      onClick={() => props.onPlaySlideshow?.(props.selectedIds)}
                      primaryDisabled={props.busy || props.items.length === 0}
                      menuLabel="More library actions"
                      items={[
                        {
                          key: "new-album",
                          label: "New album",
                          icon: PlusIcon,
                          onClick: () => props.onCreateAlbum?.(),
                        },
                      ]}
                    />
                  </div>
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
                          <Icon size={l === "timeline" ? 18 : 14} />
                        </button>
                      );
                    })}
                  </div>
                  <button
                    className="compact-view-options"
                    type="button"
                    aria-label="View options"
                    title="View options"
                    aria-expanded={viewOptionsOpen}
                    onClick={() => setViewOptionsOpen(!viewOptionsOpen)}
                  >
                    <MoreIcon size={16} />
                  </button>
                  {/* Details rows use a fixed thumbnail, so size only matters
                      for the visual layouts. A divider keeps the two icon
                      groups from reading as one six-button control. */}
                  {props.layout !== "details" && (
                    <span className="toolbar-divider" aria-hidden="true" />
                  )}
                  {props.layout !== "details" && (
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
                  )}
                </div>
                {!props.hiddenView && (
                  <div
                    className="sort-control"
                    role="group"
                    aria-label={`Sort options; ${sortDirectionLabel}`}
                  >
                    <select
                      aria-label="Sort library by"
                      disabled={catalogTimeline}
                      title={catalogTimeline ? "Timeline is always sorted by date" : undefined}
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
                      disabled={catalogTimeline}
                      title={
                        catalogTimeline
                          ? "Timeline is always sorted by date, newest first"
                          : `Currently ${sortDirectionLabel}; click to sort ${nextSortDirectionLabel}`
                      }
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
            <div className="segmented-control" role="group" aria-label="Media type">
              {(["All", "Photos", "Videos", "RAW", "Animations", "Favorites"] as const).map((f) => {
                // Album/collection counts must come from the full collection on
                // screen, not the type-filtered `props.items` (selecting "Photos"
                // in an album with no photos would zero every count).
                const count = props.activeAlbum
                  ? filterCounts[f]
                  : f === "All"
                    ? (props.libraryStats?.photos ?? 0) +
                      (props.libraryStats?.videos ?? 0) +
                      (props.libraryStats?.raws ?? 0) +
                      (props.libraryStats?.animations ?? 0)
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
                    className={`quick-filter ${props.filter === f ? "active" : ""} ${
                      count === 0 && f !== "All" ? "is-empty" : ""
                    }`}
                    title={
                      count === 0 && f !== "All"
                        ? `No ${f === "RAW" ? "RAW files" : f.toLowerCase()} here`
                        : undefined
                    }
                    onClick={() => props.onChangeFilter(f as Filter)}
                  >
                    {f}
                    <span className="filter-count">{count.toLocaleString()}</span>
                  </button>
                );
              })}
            </div>
            <span className="filter-cluster-separator" aria-hidden="true" />
            <FilterDropdown
              minRating={props.minRating}
              colorLabelFilter={props.colorLabelFilter}
              dateFrom={props.dateFrom}
              dateTo={props.dateTo}
              tags={library.tags}
              tagsFilter={library.tagsFilter}
              onSetMinRating={props.onSetMinRating}
              onSetColorLabelFilter={props.onSetColorLabelFilter}
              onSetTagsFilter={library.setTagsFilter}
              onSetDateRange={props.onSetDateRange}
              onCreateSmartAlbum={props.onCreateSmartAlbum}
            />
            {!props.hiddenView && (
              <ActiveRefinements
                tags={library.tagsFilter}
                minRating={props.minRating}
                colorLabel={props.colorLabelFilter}
                camera={library.cameraFilter}
                lens={library.lensFilter}
                dateLabel={dateFilterLabel}
                onRemoveTag={(tag) =>
                  library.setTagsFilter(library.tagsFilter.filter((name) => name !== tag))
                }
                onClearRating={() => props.onSetMinRating(null)}
                onClearColor={() => props.onSetColorLabelFilter(null)}
                onClearCamera={() => library.setCameraFilter(null)}
                onClearLens={() => library.setLensFilter(null)}
                onClearDate={() => props.onSetDateRange(null, null)}
              />
            )}
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
                <span className="selection-bar-count">{selectionSummary}</span>
                {selectedItems.length === props.selectedIds.length && (
                  <>
                    <span className="selection-bar-divider" aria-hidden="true" />
                    <span className="selection-bar-size">
                      {formatBytesSimple(
                        selectedItems.reduce((sum, item) => sum + (item.size || 0), 0),
                      )}
                    </span>
                  </>
                )}
              </div>
              <div className="selection-bar-actions">
                {!allVisibleSelected && (
                  <button
                    type="button"
                    className="selection-bar-action selection-bar-clear"
                    onClick={() => props.onClearSelection?.()}
                    title="Clear selection (inspection is kept)"
                  >
                    Clear selection
                  </button>
                )}
                <button
                  type="button"
                  className="selection-bar-action"
                  onClick={toggleSelectAllVisible}
                  title={allVisibleSelected ? "Deselect all shown items" : "Select all shown items"}
                >
                  <CheckIcon size={12} />
                  {allVisibleSelected ? "Deselect all" : "Select all"}
                </button>
                <SplitButton
                  label="View"
                  icon={FullscreenIcon}
                  onClick={() => props.onOpenViewer?.(props.selectedIds[0])}
                  menuLabel="More selection actions"
                  items={[
                    {
                      key: "play",
                      label: selectionPlaysInViewer ? "Play selected videos" : "Slideshow",
                      icon: PlayIcon,
                      onClick: () => props.onPlaySlideshow?.(props.selectedIds),
                    },
                    {
                      key: "favorite",
                      label: anySelectedFavorite ? "Unfavorite" : "Favorite",
                      icon: HeartIcon,
                      onClick: () =>
                        props.onSetFavoriteForIds(props.selectedIds, !anySelectedFavorite),
                    },
                    {
                      key: "hide",
                      label: anySelectedHidden ? "Unhide" : "Hide",
                      icon: anySelectedHidden ? EyeOffIcon : EyeIcon,
                      onClick: () => props.onSetHiddenForIds(props.selectedIds, !anySelectedHidden),
                    },
                    ...(!inAlbum
                      ? [
                          {
                            key: "album",
                            label: "Add to album",
                            icon: AlbumsIcon,
                            onClick: () => props.onOpenAlbumPicker?.(props.selectedIds),
                          },
                        ]
                      : []),
                    {
                      key: "tags",
                      label: "Tags to Finder",
                      icon: TagIcon,
                      disabled: !selectedItems.some((item) => item.tags?.length),
                      title:
                        "Merge VistoGallery tags into each file's Finder tags. Existing Finder tags are kept.",
                      onClick: () => props.onCopyTagsToFinder?.(props.selectedIds),
                    },
                  ]}
                />
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
                    <TrashIcon size={13} /> Move to Trash
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
          role={props.layout === "details" ? "table" : undefined}
        >
          {props.layout === "details" && (
            <div className="details-header-sticky list-view-header" role="rowgroup">
              <div
                className="details-col list-view-head-cell details-preview-heading"
                role="columnheader"
              >
                Preview
              </div>
              {detailsHeader("Name", "name")}
              {detailsHeader("Captured", "capturedAt")}
              {detailsHeader("Kind", "kind", "details-col-kind")}
              {detailsHeader("Size", "size", "details-col-size")}
            </div>
          )}
          {(() => {
            if (props.layout === "details") {
              return (
                <div className="gallery-grid layout-details list-view" role="rowgroup">
                  {renderedItems.length === 0 && (awaitingFirstPage ? skeletonView() : emptyView())}
                  {renderedItems.map((item) => (
                    <article
                      key={item.id}
                      className={tileClass(item)}
                      role="row"
                      {...tileActivationHandlers(item)}
                      onContextMenu={(e) => {
                        concealItem(item.id);
                        props.onContextMenu(itemContextMenu(item), e);
                      }}
                    >
                      <div
                        className="tile-select-check"
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIdSet.has(item.id)}
                          onChange={() => props.onToggleSelect(item.id)}
                          title={
                            selectedIdSet.has(item.id)
                              ? "Remove from selection"
                              : "Add to selection"
                          }
                          onClick={(e) => e.stopPropagation()}
                        />
                        <CheckIcon size={12} />
                      </div>
                      <button
                        type="button"
                        className="tile-open-button"
                        data-item-id={item.id}
                        aria-label={`Open ${tileAlt(item)}`}
                        {...holdHandlers(item.id)}
                      />
                      <span className="tile-image" role="gridcell">
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
                          <LivePhotoThumb
                            itemId={item.id}
                            name={tileAlt(item)}
                            size={thumbnailPixels}
                            style={draftImageStyle(draftTransforms, item.id)}
                            fallbackSrc={assetUrl(item.path)}
                            motionSrc={livePhotoMotionSrc(livePhotoMotionByItemId, item, assetUrl)}
                          />
                        ) : (
                          <CachedThumbnail
                            itemId={item.id}

                            name={tileAlt(item)}

                            size={thumbnailPixels}

                            style={draftImageStyle(draftTransforms, item.id)}
                          />
                        )}
                        {item.kind === "video" && props.onPlayBackground && (
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
                      </span>
                      <span
                        className={`tile-caption${masked(item) ? " hidden-caption" : ""}`}
                        role="gridcell"
                      >
                        <b>
                          {masked(item) ? (
                            "Hidden item"
                          ) : (
                            <>
                              <MiddleTruncate
                                text={displayFileName(item.name, item.extension, showExtensions)}
                              />
                              <ListRowMeta item={item} />
                            </>
                          )}
                        </b>
                        <small className="tile-date">{formatItemDate(item)}</small>
                        <small className="tile-kind">
                          <KindDot kind={item.kind} />
                          {item.kind === "video" ? "Video" : item.kind === "raw" ? "RAW" : "Photo"}
                        </small>
                        <small className="tile-size">{formatBytesSimple(item.size)}</small>
                      </span>
                    </article>
                  ))}
                  {props.items.length === 0 && (awaitingFirstPage ? skeletonView() : emptyView())}
                </div>
              );
            }
            if (props.layout === "timeline") {
              return (
                <div className={`gallery-grid layout-timeline thumb-${thumbnailSize}`}>
                  {timelineMonths.length > 1 && (
                    <nav className="timeline-jump" aria-label="Jump to a year or month">
                      <div className="timeline-jump-years">
                        {timelineYears.map(({ year, count, months }) => (
                          <button
                            key={year}
                            type="button"
                            className="timeline-jump-year"
                            title={`${count.toLocaleString()} ${count === 1 ? "item" : "items"}`}
                            aria-label={`Jump to ${year}`}
                            onClick={() => jumpToTimelineMonth(months[0].key, true)}
                          >
                            {year}
                          </button>
                        ))}
                      </div>
                      <DateJump years={timelineYears} jump={jumpToTimelineMonth} />
                    </nav>
                  )}
                  {timelineMonths.length === 0 ||
                  (awaitingFirstPage && visibleTimelineGroups.length === 0)
                    ? awaitingFirstPage
                      ? skeletonView()
                      : emptyView()
                    : visibleTimelineGroups.map((month, index) => {
                        const { key, label, count, visibleItems, collapsed, coverIds } = month;
                        const year = monthYear(key);
                        const yearGroup = yearsByKey.get(year)!;
                        const yearStarts =
                          index === 0 || monthYear(visibleTimelineGroups[index - 1].key) !== year;
                        const allSelected = monthAllSelected(month);
                        const countLabel = `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;
                        return (
                          <React.Fragment key={key}>
                            {yearStarts && timelineYears.length > 1 && (
                              <div className="timeline-year" id={`timeline-year-${year}`}>
                                <button
                                  type="button"
                                  className="timeline-year-toggle"
                                  aria-expanded={!yearGroup.collapsed}
                                  title="Option-click to expand or collapse every year"
                                  onClick={(e) => toggleTimelineYear(year, e.altKey)}
                                >
                                  <ChevronDownIcon size={13} />
                                  <span>{year}</span>
                                </button>
                                <span className="timeline-count">
                                  {yearGroup.count.toLocaleString()}{" "}
                                  {yearGroup.count === 1 ? "item" : "items"}
                                </span>
                              </div>
                            )}
                            <div
                              className={`timeline-group${collapsed ? " collapsed" : ""}`}
                              id={`timeline-month-${key}`}
                              data-month={key}
                            >
                              <h3>
                                <button
                                  type="button"
                                  className="timeline-month-toggle"
                                  aria-expanded={!collapsed}
                                  aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
                                  title="Option-click to expand or collapse every month"
                                  onClick={(e) => toggleTimelineCollapse(key, collapsed, e.altKey)}
                                >
                                  <ChevronDownIcon size={14} />
                                  {label}
                                </button>
                              </h3>
                              {collapsed && (
                                <button
                                  type="button"
                                  className="timeline-covers"
                                  aria-label={`Show ${countLabel} from ${label}`}
                                  onClick={() => timelineCollapse.setMonth(key, false)}
                                >
                                  {coverIds.slice(0, 4).map((id) => (
                                    <span key={id} className="timeline-cover">
                                      {veiled ? (
                                        <EyeOffIcon size={15} />
                                      ) : (
                                        <CachedThumbnail itemId={id} name="" size={128} />
                                      )}
                                    </span>
                                  ))}
                                  {count > coverIds.length && (
                                    <span className="timeline-cover-more">
                                      +{(count - Math.min(coverIds.length, 4)).toLocaleString()}
                                    </span>
                                  )}
                                </button>
                              )}
                              <span className="timeline-count">{countLabel}</span>
                              <button
                                type="button"
                                className="timeline-select-group"
                                aria-pressed={allSelected}
                                onClick={() => void toggleTimelineMonth(month)}
                                title={`Select or deselect all ${countLabel} from ${label}`}
                              >
                                <span className="timeline-select-box">
                                  {allSelected ? <CheckIcon size={11} /> : null}
                                </span>
                                {allSelected ? "Selected" : "Select all"}
                              </button>
                            </div>
                            {!collapsed &&
                              visibleItems.map((item) => (
                                <article
                                  key={item.id}
                                  className={tileClass(item)}
                                  {...tileActivationHandlers(item)}
                                  onContextMenu={(e) => {
                                    concealItem(item.id);
                                    props.onContextMenu(itemContextMenu(item), e);
                                  }}
                                >
                                  <div
                                    className="tile-select-check"
                                    onClick={(e) => e.stopPropagation()}
                                    onDoubleClick={(e) => e.stopPropagation()}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={selectedIdSet.has(item.id)}
                                      onChange={() => props.onToggleSelect(item.id)}
                                      title={
                                        selectedIdSet.has(item.id)
                                          ? "Remove from selection"
                                          : "Add to selection"
                                      }
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                    <CheckIcon size={12} />
                                  </div>
                                  <button
                                    type="button"
                                    className="tile-open-button"
                                    data-item-id={item.id}
                                    aria-label={`Open ${tileAlt(item)}`}
                                    {...holdHandlers(item.id)}
                                  />
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
                                      <LivePhotoThumb
                                        itemId={item.id}
                                        name={tileAlt(item)}
                                        size={thumbnailPixels}
                                        style={draftImageStyle(draftTransforms, item.id)}
                                        fallbackSrc={assetUrl(item.path)}
                                        motionSrc={livePhotoMotionSrc(
                                          livePhotoMotionByItemId,
                                          item,
                                          assetUrl,
                                        )}
                                      />
                                    ) : (
                                      <CachedThumbnail
                                        itemId={item.id}

                                        name={tileAlt(item)}

                                        size={thumbnailPixels}

                                        style={draftImageStyle(draftTransforms, item.id)}
                                      />
                                    )}
                                    {item.kind === "video" && props.onPlayBackground && (
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
                                        <HeartIcon size={10} filled />
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
                                      <MiddleTruncate
                                        text={displayFileName(
                                          item.name,
                                          item.extension,
                                          showExtensions,
                                        )}
                                      />
                                    </b>
                                    <small className="tile-date">{formatItemDate(item)}</small>
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
                                </article>
                              ))}
                            {!collapsed &&
                              (pages?.has(key)
                                ? pages.get(key)?.nextCursor
                                : visibleItems.length < count) && (
                                <MonthContinuation
                                  key={timelineRefreshKey}
                                  month={key}
                                  view={timelineRefreshKey}
                                  filter={timelineFilter}
                                  cursor={pages?.get(key)?.nextCursor ?? null}
                                />
                              )}
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
                {virtualGrid.items.map((item) => (
                  <article
                    key={item.id}
                    className={tileClass(item)}
                    {...tileActivationHandlers(item)}
                    onContextMenu={(e) => {
                      concealItem(item.id);
                      props.onContextMenu(itemContextMenu(item), e);
                    }}
                  >
                    <div
                      className="tile-select-check"
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={selectedIdSet.has(item.id)}
                        onChange={() => props.onToggleSelect(item.id)}
                        title={
                          selectedIdSet.has(item.id) ? "Remove from selection" : "Add to selection"
                        }
                        onClick={(e) => e.stopPropagation()}
                      />
                      <CheckIcon size={12} />
                    </div>
                    <button
                      type="button"
                      className="tile-open-button"
                      data-item-id={item.id}
                      aria-label={`Open ${tileAlt(item)}`}
                      {...holdHandlers(item.id)}
                    />
                    <span className="tile-image">
                      {item.kind === "video" ? (
                        props.layout !== "grid" && canPlayVideoInApp(item.path, item.name) ? (
                          <VideoThumb src={assetUrl(item.path)} name={tileAlt(item)} />
                        ) : (
                          <VideoPoster
                            itemId={item.id}
                            name={tileAlt(item)}
                            size={thumbnailPixels}
                            fallbackSrc={
                              canPlayVideoInApp(item.path, item.name)
                                ? assetUrl(item.path)
                                : undefined
                            }
                          />
                        )
                      ) : item.kind === "photo" ? (
                        <LivePhotoThumb
                          itemId={item.id}
                          name={tileAlt(item)}
                          size={thumbnailPixels}
                          style={draftImageStyle(draftTransforms, item.id)}
                          fallbackSrc={assetUrl(item.path)}
                          motionSrc={livePhotoMotionSrc(livePhotoMotionByItemId, item, assetUrl)}
                        />
                      ) : (
                        <CachedThumbnail
                          itemId={item.id}
                          name={tileAlt(item)}
                          size={thumbnailPixels}
                          style={draftImageStyle(draftTransforms, item.id)}
                        />
                      )}
                      {item.kind === "video" && props.onPlayBackground && (
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
                          {props.layout === "grid" ? (
                            <KindBadge kind="video" />
                          ) : (
                            <PlayIcon size={10} />
                          )}
                        </span>
                      )}
                      {item.kind === "raw" && (
                        <span className="format-label">
                          <KindBadge kind={item.kind} />
                        </span>
                      )}
                      {item.favorite && !masked(item) ? (
                        <span className="tile-favorite" aria-label="Favorite">
                          <HeartIcon size={10} filled />
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
                            <span
                              key={i}
                              className={`star ${i < (item.rating ?? 0) ? "filled" : ""}`}
                            >
                              {"\u2605"}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                    <span className={`tile-caption${masked(item) ? " hidden-caption" : ""}`}>
                      <b>
                        <MiddleTruncate
                          text={displayFileName(item.name, item.extension, showExtensions)}
                        />
                      </b>
                      <small className="tile-date">{formatItemDate(item)}</small>
                      <small className="tile-kind">
                        {item.kind === "video" ? "Video" : item.kind === "raw" ? "RAW" : "Photo"}
                      </small>
                      <small className="tile-size">{formatBytesSimple(item.size)}</small>
                    </span>
                  </article>
                ))}
                {virtualGrid.bottomSpacer > 0 && (
                  <div
                    className="grid-virtual-spacer"
                    aria-hidden="true"
                    style={{ height: virtualGrid.bottomSpacer }}
                  />
                )}
                {props.items.length === 0 && (awaitingFirstPage ? skeletonView() : emptyView())}
              </div>
            );
          })()}
          {!timelineActive && !supportsGridVirtualization && renderLimit < props.items.length && (
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
        <LibraryInspector
          item={inspectedItem}
          isSelected={inspectedItem ? selectedIdSet.has(inspectedItem.id) : false}
          selectedCount={props.selectedIds.length}
          masked={inspectedItem ? masked(inspectedItem) : false}
          previewHandlers={inspectedItem ? holdHandlers(inspectedItem.id) : undefined}
          assetUrl={assetUrl}
          draftTransforms={draftTransforms}
          veiled={veiled}
          canPlayBackground={Boolean(props.onPlayBackground)}
          playingId={playingId}
          isPlaying={isPlaying}
          toggleBackground={toggleBackground}
          copyItemPath={copyItemPath}
          copiedPathFor={copiedPathFor}
          actions={props}
        />
      )}
    </div>
  );
}

export default LibraryScreen;
