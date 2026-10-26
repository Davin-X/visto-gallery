import React, {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
  useDeferredValue,
} from "react";
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
  PlayIcon,
  PlusIcon,
  SearchIcon,
  TimelineIcon,
  TrashIcon,
} from "../design/components/icons";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import { KindBadge, KindDot } from "../design/components/KindBadge";
import VideoThumb from "../design/components/VideoThumb";
import { AlbumPhotoStack } from "../design/components/AlbumPhotoStack";
import {
  useDraftTransforms,
  draftTransformStyle,
} from "../engine/stores/useEditStore";
import { useLibraryStore } from "../engine/stores/useLibraryStore";
import { useSettingsStore } from "../engine/stores/useSettingsStore";
import { useThumbnailSize } from "../engine/stores/useSettingsStore";
import { tauri } from "../engine/commands/tauri";
import { formatBytesSimple } from "../engine/utils/mediaTypes";
import type {
  MediaItem,
  Album,
  Filter,
  LayoutMode,
} from "../engine/types/media";
import type { LibraryFolder } from "../engine/types/commands";

function draftImageStyle(
  transforms: Map<string, any> | undefined,
  itemId: string,
) {
  const transform = draftTransformStyle(transforms?.get(itemId));
  return transform ? { transform } : undefined;
}

const GALLERY_PAGE_SIZE = 180;

function searchShortcutLabel(): string {
  if (typeof navigator === "undefined") return "⌘F";
  const uaData = (
    navigator as unknown as { userAgentData?: { platform?: string } }
  ).userAgentData;
  const platform = uaData?.platform || navigator.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘F" : "Ctrl F";
}

interface LibraryScreenProps {
  activeAlbum: string | null;
  albumDragOver?: boolean;
  albums: Album[];
  assetUrl: (path: string) => string;
  busy: boolean;
  filter: Filter;
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
  onCreateAlbum: (itemIds?: string[]) => void;
  onImportFiles?: () => void;
  onImportFolder?: () => void;
  onInspectItem: (id: string) => void;
  onOpenAlbumPicker: (itemIds?: string[]) => void;
  onOpenAlbums: () => void;
  onOpenBatch?: (ids?: string[]) => void;
  onOpenEdit: (item: MediaItem) => void;
  onOpenViewer: (id?: string) => void;
  onPlaySlideshow: (ids?: string[]) => void;
  onRequestDeleteItems: (ids: string[]) => void;
  onRequestRemoveFromAlbum?: (albumId: string, itemIds: string[]) => void;
  onSelectRange: (startId: string, endId: string) => void;
  onSetActiveAlbum: (albumId: string | null) => void;
  onSetFavoriteForIds: (
    ids: string[],
    favorite: boolean,
  ) => void | Promise<void>;
  onSetHiddenForIds: (ids: string[], hidden: boolean) => void | Promise<void>;
  onSetSelection: (ids: string[]) => void;
  onToggleFavorite: (id: string) => void | Promise<void>;
  onToggleHidden: (id: string) => void | Promise<void>;
  onToggleInspector: () => void;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onDeleteItems: (ids: string[]) => void | Promise<void>;
  onUpdateTags: (id: string, tags: string[]) => void | Promise<void>;
  query: string;
  notice: any;
  progress: any;
  searchInputRef: any;
  selectedIds: string[];
  showInspector: boolean;
}

function LibraryScreen(props: LibraryScreenProps) {
  const library = useLibraryStore();
  const draftTransforms = useDraftTransforms();
  const thumbnailSize = useThumbnailSize();
  const settingsStore = useSettingsStore();
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
  const masked = (item: any) =>
    Boolean(props.hiddenView) && !revealedIds.has(item.id);
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
  const activeAlbumName = props.activeAlbum
    ? (activeAlbumRecord?.name ?? "Album")
    : null;
  const inAlbum = Boolean(props.activeAlbum);
  const activeAlbumItems = useMemo(
    () =>
      props.activeAlbum
        ? library.items.filter(
            (item: any) =>
              item.albumIds?.includes(props.activeAlbum) && !item.hidden,
          )
        : [],
    [library.items, props.activeAlbum],
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
      (item: any) =>
        item.path === library.activeSource || item.path.startsWith(prefix),
    );
  }, [
    library.items,
    library.hiddenItems,
    library.activeSource,
    props.hiddenView,
  ]);
  const filterSource = inAlbum ? activeAlbumItems : sourceItems;
  // The SHOW row used to run one full filter pass per chip on every render.
  // One pass keeps the counts in sync and is O(n) instead of 6 × O(n).
  const filterCounts = useMemo(() => {
    const counts = { All: 0, Photos: 0, Videos: 0, RAW: 0, Favorites: 0 };
    for (const item of filterSource) {
      if (!props.hiddenView && item.hidden) continue;
      counts.All += 1;
      if (item.kind === "photo") counts.Photos += 1;
      else if (item.kind === "video") counts.Videos += 1;
      else if (item.kind === "raw") counts.RAW += 1;
      if (item.favorite) counts.Favorites += 1;
    }
    return counts;
  }, [filterSource, props.hiddenView]);
  const clearEmptyView = () => {
    props.onChangeQuery("");
    props.onChangeFilter("All");
    if (!props.hiddenView) library.setActiveSource(null);
  };

  const emptyView = () => {
    if (props.hiddenView) {
      const nothingHidden = props.hiddenCount === 0;
      return (
        <div className="empty-state" style={{ gridColumn: "1/-1" }}>
          <span>
            {nothingHidden ? (
              <EyeOffIcon size={28} />
            ) : (
              <ImageOffIcon size={28} />
            )}
          </span>
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
            <button type="button" onClick={clearEmptyView}>
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
          {albumEmpty ? <AlbumsIcon size={30} /> : <ImageOffIcon size={28} />}
        </span>
        <b>
          {albumEmpty
            ? props.albumDragOver
              ? "Drop to add to this album"
              : "This album is empty"
            : props.items?.length === 0
              ? "Your library is empty"
              : "No photos match"}
        </b>
        <p>
          {albumEmpty
            ? "Drag files here or use Add Items. You can also select photos in Library and choose Add to album."
            : props.items?.length === 0
              ? "Add a folder to start indexing photos and videos."
              : "Try another filter or search."}
        </p>
        {albumEmpty ? (
          <div className="album-empty-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() =>
                props.activeAlbum && props.onAddItems?.(props.activeAlbum)
              }
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
        ) : props.items?.length === 0 ? (
          <button
            className="primary-button"
            type="button"
            onClick={() => props.onImportFolder?.()}
          >
            <PlusIcon size={14} /> Add a folder
          </button>
        ) : (
          <button type="button" onClick={clearEmptyView}>
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

  // A new view starts at the top of the list again.
  useEffect(() => {
    setRenderLimit(GALLERY_PAGE_SIZE);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [
    props.filter,
    props.query,
    props.activeAlbum,
    library.activeSource,
    props.layout,
  ]);

  const loadMore = () => {
    setRenderLimit((n) => Math.min(n + GALLERY_PAGE_SIZE, props.items.length));
  };

  const handleGridScroll = () => {
    const el = scrollRef.current;
    if (!el || renderLimit >= props.items.length) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 800) loadMore();
  };
  const handleGridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const rawTarget =
        (e.target as HTMLElement) || (document.activeElement as HTMLElement);
      const button =
        (rawTarget?.closest?.(
          ".tile-open-button",
        ) as HTMLButtonElement | null) ||
        ((document.activeElement as HTMLElement | null)?.closest?.(
          ".tile-open-button",
        ) as HTMLButtonElement | null);
      if (!button) return;
      const buttons = Array.from(
        scrollRef.current?.querySelectorAll<HTMLButtonElement>(
          ".tile-open-button",
        ) ?? [],
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      handleGridKeyDown(e as unknown as React.KeyboardEvent<HTMLDivElement>);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleGridKeyDown]);

  const renderedItems = useMemo(
    () => props.items.slice(0, renderLimit),
    [props.items, renderLimit],
  );
  const selectedIdSet = useMemo(
    () => new Set(props.selectedIds),
    [props.selectedIds],
  );

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
            const grouped = new Map<
              string,
              { timestamp: number; items: any[] }
            >();
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
        <button
          type="button"
          className="details-sort-header"
          onClick={() => sortDetailsBy(sortBy)}
        >
          {label}
          <span aria-hidden="true">
            {library.sortBy === sortBy
              ? library.sortOrder === "asc"
                ? "↑"
                : "↓"
              : "↕"}
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
    const allSelected =
      groupIds.length > 0 && groupIds.every((id) => selectedIdSet.has(id));
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
    if (
      e.shiftKey &&
      lastClickedRef.current &&
      lastClickedRef.current !== item.id
    ) {
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
      label: "Open in Finder",
      onClick: () => tauri.items.revealInFinder(item.path),
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
              props.activeAlbum &&
              props.onRequestRemoveFromAlbum?.(props.activeAlbum, [item.id]),
          },
        ]
      : []),
    { label: "New Album…", onClick: () => props.onCreateAlbum?.([item.id]) },
    { divider: true },
    { label: "Favorite", onClick: () => props.onToggleFavorite(item.id) },
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
    return library.items.filter((i: any) => ids.has(i.id));
  }, [library.items, props.selectedIds]);
  const anySelectedFavorite = selectedItems.some((i: any) => i.favorite);
  const anySelectedHidden = selectedItems.some((i: any) => i.hidden);
  // Play on a video-only selection opens the player; anything with a photo
  // starts a slideshow. The label follows the action so it is never a surprise.
  const selectionPlaysInViewer =
    selectedItems.length > 0 &&
    selectedItems.every((i: any) => i.kind === "video");
  // Say what is actually in the selection: "3 photos · 2 videos" explains the
  // Play/Slideshow label and avoids surprises when a filter hides some of them.
  const selectedKindCounts = useMemo(() => {
    const counts: Record<string, number> = { photo: 0, video: 0, raw: 0 };
    for (const item of selectedItems)
      counts[item.kind] = (counts[item.kind] || 0) + 1;
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
    props.items.length > 0 &&
    props.items.every((item: any) => selectedIdSet.has(item.id));
  const toggleSelectAllVisible = () => {
    props.onSetSelection?.(
      allVisibleSelected ? [] : props.items.map((item: any) => item.id),
    );
  };

  return (
    <div
      className={`library-layout ${props.showInspector ? "with-inspector" : ""}`}
    >
      <section className="library-center">
        <header className="library-header">
          {inAlbum ? (
            <div className="album-detail-top">
              <button
                className="album-breadcrumb"
                type="button"
                onClick={() => props.onOpenAlbums?.()}
              >
                <AlbumsIcon size={15} /> All albums
              </button>
              <div className="album-detail-heading">
                <div
                  className={`album-detail-cover${activeAlbumPhotos.length ? "" : " is-empty"}`}
                >
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
                  <p className="page-subtitle">
                    {activeAlbumCount.toLocaleString()}{" "}
                    {activeAlbumCount === 1 ? "item" : "items"}
                    {" · "}
                    {props.items.length.toLocaleString()} shown
                  </p>
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
                    onClick={() =>
                      props.activeAlbum && props.onAddItems?.(props.activeAlbum)
                    }
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
                  <p className="page-subtitle">
                    {props.items.length.toLocaleString()} shown ·{" "}
                    {props.hiddenView
                      ? `${(props.hiddenCount || 0).toLocaleString()} hidden`
                      : `${(library.items.length - library.hiddenCount).toLocaleString()} in library`}
                    {!props.hiddenView && props.hiddenCount
                      ? ` · ${props.hiddenCount.toLocaleString()} hidden`
                      : ""}
                  </p>
                </div>
              </div>
              <div className="header-actions">
                <button
                  className="quiet-button icon-only"
                  type="button"
                  onClick={() => props.onPlaySlideshow?.(props.selectedIds)}
                  disabled={props.busy || props.items.length === 0}
                  title="Play the current view as a slideshow (Space)"
                  aria-label="Play slideshow"
                >
                  <PlayIcon size={16} />
                </button>
                {!props.hiddenView && (
                  <>
                    <label
                      className="source-select"
                      title="Filter the library by source"
                    >
                      <FolderIcon size={14} />
                      <span className="source-select-label">Source</span>
                      <select
                        value={library.activeSource ?? ""}
                        onChange={(e) =>
                          library.setActiveSource(e.target.value || null)
                        }
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
                      title="Open folder (⌘O)"
                      aria-label="Open folder"
                    >
                      <FolderIcon size={15} />
                      <span className="btn-label">Open folder</span>
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
                Hidden from the gallery only. Files stay on disk at their
                original paths and are not encrypted.
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
                  if (e.key === "Escape" && props.query)
                    props.onChangeQuery("");
                }}
                placeholder={
                  props.hiddenView
                    ? "Search hidden items…"
                    : "Search filenames, tags, camera…"
                }
                aria-label={
                  props.hiddenView ? "Search hidden items" : "Search library"
                }
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
                {!props.hiddenView && (
                  <button
                    className="toolbar-button"
                    type="button"
                    onClick={() => props.onCreateAlbum?.()}
                    title="Create album (⌘N)"
                  >
                    <PlusIcon size={14} /> Album
                  </button>
                )}
                <span className="toolbar-divider" aria-hidden="true" />
                <div className="layout-switcher" aria-label="Gallery layout">
                  {(["grid", "details", "timeline"] as const).map((l) => {
                    const Icon =
                      l === "grid"
                        ? GridIcon
                        : l === "details"
                          ? DetailsIcon
                          : TimelineIcon;
                    return (
                      <button
                        key={l}
                        type="button"
                        aria-label={l}
                        title={l}
                        className={props.layout === l ? "selected" : ""}
                        onClick={() => props.onChangeLayout(l)}
                      >
                        <Icon size={14} />
                      </button>
                    );
                  })}
                </div>
                <div className="zoom-control" aria-label="Thumbnail size">
                  {(["small", "medium", "large"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`zoom-step ${thumbnailSize === s ? "selected" : ""}`}
                      onClick={() => settingsStore.update("thumbnailSize", s)}
                      title={
                        s === "small"
                          ? "Small thumbnails"
                          : s === "medium"
                            ? "Medium thumbnails"
                            : "Large thumbnails"
                      }
                    >
                      {s === "small" ? "S" : s === "medium" ? "M" : "L"}
                    </button>
                  ))}
                </div>
                {!props.hiddenView && (
                  <div className="sort-control">
                    <select
                      aria-label="Sort library"
                      value={library.sortBy}
                      onChange={(e) =>
                        library.setSort(
                          e.target.value as typeof library.sortBy,
                          library.sortOrder,
                        )
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
                      aria-label={
                        library.sortOrder === "asc"
                          ? "Sort ascending"
                          : "Sort descending"
                      }
                      title={
                        library.sortOrder === "asc" ? "Ascending" : "Descending"
                      }
                      onClick={() =>
                        library.setSort(
                          library.sortBy,
                          library.sortOrder === "asc" ? "desc" : "asc",
                        )
                      }
                    >
                      {library.sortOrder === "asc" ? "↑" : "↓"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="filter-cluster">
            <span className="smart-label">SHOW</span>
            {(["All", "Photos", "Videos", "RAW", "Favorites"] as string[]).map(
              (f) => {
                const count = filterCounts[f as keyof typeof filterCounts] ?? 0;
                return (
                  <button
                    key={f}
                    type="button"
                    className={`quick-filter ${props.filter === f ? "active" : ""}`}
                    onClick={() => props.onChangeFilter(f as Filter)}
                  >
                    {f}
                    <span className="filter-count">{count}</span>
                  </button>
                );
              },
            )}
          </div>

          {props.selectedIds.length > 0 && (
            <div
              className="selection-bar"
              role="toolbar"
              aria-label="Selection actions"
            >
              <div className="selection-bar-left">
                <span className="selection-bar-count">
                  {props.selectedIds.length.toLocaleString()} selected
                </span>
                <span className="selection-bar-divider" aria-hidden="true" />
                <span className="selection-bar-size">
                  {formatBytesSimple(
                    selectedItems.reduce(
                      (sum: number, item: any) => sum + (item.size || 0),
                      0,
                    ),
                  )}{" "}
                  selected
                </span>
                {selectedKindSummary && (
                  <>
                    <span
                      className="selection-bar-divider"
                      aria-hidden="true"
                    />
                    <span className="selection-bar-kinds">
                      {selectedKindSummary}
                    </span>
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
                  title={
                    allVisibleSelected
                      ? "Deselect all shown items"
                      : "Select all shown items"
                  }
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
                  <PlayIcon size={13} />{" "}
                  {selectionPlaysInViewer ? "Play" : "Slideshow"}
                </button>
                <button
                  type="button"
                  className="selection-bar-action"
                  onClick={() =>
                    props.onSetFavoriteForIds(
                      props.selectedIds,
                      !anySelectedFavorite,
                    )
                  }
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
                  onClick={() =>
                    props.onSetHiddenForIds(
                      props.selectedIds,
                      !anySelectedHidden,
                    )
                  }
                  title={
                    anySelectedHidden
                      ? "Unhide all selected"
                      : "Hide all selected"
                  }
                >
                  {anySelectedHidden ? (
                    <EyeOffIcon size={13} />
                  ) : (
                    <EyeIcon size={13} />
                  )}
                  {anySelectedHidden ? "Unhide" : "Hide"}
                </button>
                <button
                  type="button"
                  className="selection-bar-action"
                  onClick={() => props.onOpenAlbumPicker?.(props.selectedIds)}
                  title="Add selected items to an album"
                >
                  <AlbumsIcon size={13} /> Add to album
                </button>
                {inAlbum && (
                  <button
                    type="button"
                    className="selection-bar-action"
                    onClick={() =>
                      props.activeAlbum &&
                      library.removeFromAlbum(
                        props.activeAlbum,
                        props.selectedIds,
                      )
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
                    onClick={() =>
                      props.onRequestDeleteItems?.(props.selectedIds)
                    }
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
                            <VideoThumb
                              src={assetUrl(item.path)}
                              name={tileAlt(item)}
                            />
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
                            <span
                              className="tile-favorite"
                              aria-label="Favorite"
                            >
                              <HeartIcon size={11} filled />
                            </span>
                          ) : null}
                        </span>
                        <span
                          className={`tile-caption${masked(item) ? " hidden-caption" : ""}`}
                        >
                          <b>{masked(item) ? "Hidden item" : item.name}</b>
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
                  {props.items.length === 0 && emptyView()}
                </div>
              );
            }
            if (props.layout === "timeline") {
              return (
                <div
                  className={`gallery-grid layout-timeline thumb-${thumbnailSize}`}
                >
                  {timelineGroups.length === 0
                    ? emptyView()
                    : visibleTimelineGroups.map(
                        ({ key, label, items, count, visibleItems }) => {
                          const allSelected =
                            items.length > 0 &&
                            items.every((item: any) =>
                              selectedIdSet.has(item.id),
                            );
                          return (
                            <React.Fragment key={key}>
                              <div className="timeline-group">
                                <div
                                  className="timeline-date-marker"
                                  aria-hidden="true"
                                >
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
                                    {allSelected ? (
                                      <CheckIcon size={11} />
                                    ) : null}
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
                                    props.onContextMenu(
                                      itemContextMenu(item),
                                      e,
                                    );
                                  }}
                                >
                                  <div className="tile-select-check">
                                    <input
                                      type="checkbox"
                                      checked={selectedIdSet.has(item.id)}
                                      onChange={() =>
                                        props.onToggleSelect(item.id)
                                      }
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
                                    onDoubleClick={() =>
                                      handleTileDoubleClick(item)
                                    }
                                    {...holdHandlers(item.id)}
                                  >
                                    <span className="tile-image">
                                      {item.kind === "video" ? (
                                        <VideoThumb
                                          src={assetUrl(item.path)}
                                          name={tileAlt(item)}
                                        />
                                      ) : item.kind === "photo" ? (
                                        <CachedThumbnail
                                          itemId={item.id}
                                          name={tileAlt(item)}
                                          size={thumbnailPixels}
                                          style={draftImageStyle(
                                            draftTransforms,
                                            item.id,
                                          )}
                                          fallbackSrc={assetUrl(item.path)}
                                        />
                                      ) : (
                                        <span className="raw-tile">
                                          <KindBadge kind={item.kind} />
                                        </span>
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
                                        <span
                                          className="tile-favorite"
                                          aria-label="Favorite"
                                        >
                                          <HeartIcon size={11} filled />
                                        </span>
                                      ) : null}
                                    </span>
                                    <span
                                      className={`tile-caption${masked(item) ? " hidden-caption" : ""}`}
                                    >
                                      <b>{item.name}</b>
                                      <small className="tile-date">
                                        {new Date(
                                          captureDate(item),
                                        ).toLocaleDateString()}
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
                        },
                      )}
                </div>
              );
            }
            return (
              <div
                className={`gallery-grid layout-${props.layout} thumb-${thumbnailSize}`}
              >
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
                          <VideoThumb
                            src={assetUrl(item.path)}
                            name={tileAlt(item)}
                          />
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
                      </span>
                      <span
                        className={`tile-caption${masked(item) ? " hidden-caption" : ""}`}
                      >
                        <b>{item.name}</b>
                        <small className="tile-date">
                          {new Date(captureDate(item)).toLocaleDateString()}
                        </small>
                        <small className="tile-kind">
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
                {props.items.length === 0 && emptyView()}
              </div>
            );
          })()}
          {renderLimit < props.items.length && (
            <div className="grid-more">
              <button type="button" className="quiet-button" onClick={loadMore}>
                Show more ·{" "}
                {(props.items.length - renderLimit).toLocaleString()} remaining
              </button>
            </div>
          )}
        </div>
      </section>

      {props.showInspector && (
        <aside className="photo-inspector">
          {props.inspectedId &&
          library.items.find((i: any) => i.id === props.inspectedId) ? (
            (() => {
              const sel = library.items.find(
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
                          {props.selectedIds.length} selected · inspection
                          independent
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
                      <video src={assetUrl(sel.path)} controls />
                    ) : (
                      <span className="raw-tile">
                        <KindBadge kind={sel.kind} />
                      </span>
                    )}
                    <span>Double-click to view</span>
                    <span className="inspector-type-badge">
                      {sel.kind === "video"
                        ? "Video"
                        : sel.kind === "raw"
                          ? "RAW"
                          : "Photo"}
                    </span>
                  </button>
                  <div className="inspector-actions">
                    <button
                      className={`inspector-action ${sel.favorite ? "favorite active" : ""}`}
                      onClick={() =>
                        props.onToggleFavorite(props.inspectedId as string)
                      }
                      title={sel.favorite ? "Unfavorite" : "Favorite"}
                    >
                      <HeartIcon size={14} filled={!!sel.favorite} />
                      <span>{sel.favorite ? "Unfavorite" : "Favorite"}</span>
                    </button>
                    <button
                      className="inspector-action"
                      onClick={() =>
                        props.onToggleHidden(props.inspectedId as string)
                      }
                      title={sel.hidden ? "Unhide" : "Hide"}
                    >
                      {sel.hidden ? (
                        <EyeOffIcon size={14} />
                      ) : (
                        <EyeIcon size={14} />
                      )}
                      <span>{sel.hidden ? "Unhide" : "Hide"}</span>
                    </button>
                    <button
                      className={`inspector-action ${isSelected ? "active" : ""}`}
                      onClick={() => props.onToggleSelect(sel.id)}
                      title={
                        isSelected
                          ? "Remove from selection"
                          : "Add to selection"
                      }
                    >
                      {isSelected ? (
                        <CheckIcon size={14} />
                      ) : (
                        <PlusIcon size={14} />
                      )}
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
                            <span className="info-value">
                              {sel.extension.toUpperCase()}
                            </span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">Dimensions</span>
                            <span className="info-value">
                              {sel.width && sel.height
                                ? `${sel.width} × ${sel.height}`
                                : "Unknown"}
                            </span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">Size</span>
                            <span className="info-value">
                              {formatBytesSimple(sel.size)}
                            </span>
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
                                  (sel.tags || []).filter(
                                    (t: string) => t !== tag,
                                  ),
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
                          if (
                            e.key === "Enter" &&
                            e.currentTarget.value.trim()
                          ) {
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
                  Single-click a photo or video to inspect its details.
                  Selection is separate — use the checkbox or + to multi-select.
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
