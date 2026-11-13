import React from "react";
import {
  AlbumsIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DetailsIcon,
  DragIcon,
  GridIcon,
  PencilIcon,
  PlusIcon,
  SlideshowIcon,
  SparkleIcon,
  TrashIcon,
} from "../design/components/icons";
import { AlbumPhotoStack } from "../design/components/AlbumPhotoStack";
import { MiddleTruncate } from "../design/components/MiddleTruncate";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import { useLibraryStore } from "../engine/stores/useLibraryStore";
import { useSettingsStore } from "../engine/stores/useSettingsStore";
import { formatFileDate } from "../engine/utils/mediaDate";
import { formatBytesSimple } from "../engine/utils/mediaTypes";
import type { Album, MediaItem } from "../engine/types/media";
import type { SmartAlbum } from "../engine/types/commands";

interface AlbumsScreenProps {
  albums: Album[];
  items: MediaItem[];
  smartAlbums?: SmartAlbum[];
  assetUrl: (path: string) => string;
  onCreateAlbum: () => void;
  onAlbumContextMenu: (album: any, e: React.MouseEvent) => void;
  onOpenAlbum: (albumId: string) => void;
  onOpenSmartAlbum?: (albumId: string) => void;
  onSmartAlbumContextMenu?: (album: SmartAlbum, e: React.MouseEvent) => void;
  onCreateSmartAlbum?: () => void;
  onEditSmartAlbum?: (album: SmartAlbum) => void;
  onDeleteSmartAlbum?: (album: SmartAlbum) => void;
  /** Same actions as the card's right-click menu, reachable without one. */
  onPlayAlbum?: (albumId: string) => void;
  onRenameAlbum?: (album: any) => void;
  onAddItemsToAlbum?: (albumId: string) => void;
  onDeleteAlbum?: (album: any) => void;
}

/** Counts in smart-album overviews can arrive undefined; treat anything
 *  missing or non-finite as empty instead of printing NaN. */
function formatAlbumCount(itemCount: unknown): string {
  const count = Number(itemCount);
  if (!Number.isFinite(count) || count <= 0) return "Empty";
  return `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;
}

/**
 * The meta row both an album card and a smart-album tile end in: accent slot,
 * name (cut in the middle so similar names stay distinguishable) and count,
 * right-aligned. Sharing it is what stops the two from drifting into different
 * layouts again — they already had once.
 */
function AlbumMeta({
  color,
  name,
  count,
}: {
  /** A stored album's accent. Smart albums have none — they are a saved filter,
   *  not an object with an identity — so they show no dot rather than a hollow
   *  one, which read as a missing image. */
  color?: string;
  name: string;
  count: string;
}) {
  return (
    <span className="album-meta">
      {color && <i className={`album-dot ${color}`} aria-hidden="true" />}
      <MiddleTruncate className="album-meta-name" text={name} tailLength={6} />
      <span className="album-meta-count">{count}</span>
    </span>
  );
}

function AlbumsScreen(props: AlbumsScreenProps) {
  const overviews = useLibraryStore((s) => s.albumOverviews);

  // Opening Albums must not fetch every album's full membership. The overview
  // query returns counts plus at most four cover candidates per album; the
  // complete membership is loaded only when a card is opened.
  const albums = React.useMemo(() => {
    const byId = new Map(overviews.map((overview) => [overview.id, overview]));
    return (props.albums || []).map((album: any) => {
      const overview = byId.get(album.id);
      const coverItems: MediaItem[] = overview?.coverItems ?? [];
      const photos = coverItems
        .filter((item: any) => item.kind === "photo" || item.kind === "video")
        .slice(0, 3);
      // The backend persists a per-album color_index (0-3); the render index used to win instead,
      // so cards swapped colours on every sort or overview refresh.
      const colorIndex = Number(album.colorIndex ?? 0);
      const palette = ["coral", "violet", "blue", "green"];
      return {
        ...album,
        itemCount: overview?.itemCount ?? album.itemCount,
        photos,
        albumItems: coverItems,
        count: Number(overview?.itemCount ?? album.itemCount),
        color: palette[((colorIndex % 4) + 4) % 4],
      };
    });
  }, [props.albums, overviews]);

  // Albums are reorderable, so the list order is user data, not an accident of
  // the query. `albumOrderIds` is the current order, used by the drag and by
  // the Move up / Move down buttons.
  const reorderAlbums = useLibraryStore((s) => s.reorderAlbums);
  const albumsView = useSettingsStore((s) => s.albumsView);
  const updateSettings = useSettingsStore((s) => s.update);

  // View-only sort for the list, layered over the persisted manual order.
  // Cycles manual → asc → desc → manual. Never persisted; cards always use
  // the manual order.
  type AlbumsSortKey = "name" | "itemCount" | "itemSize" | "updatedAt";
  const [albumsSort, setAlbumsSort] = React.useState<{
    key: AlbumsSortKey;
    dir: "asc" | "desc";
  } | null>(null);
  const sortedAlbums = React.useMemo(() => {
    if (!albumsSort) return albums;
    const { key, dir } = albumsSort;
    const mult = dir === "asc" ? 1 : -1;
    const read = (album: any): string | number => {
      if (key === "name") return String(album.name ?? "").toLowerCase();
      if (key === "itemSize") return Number(album.itemSize ?? 0) || 0;
      if (key === "itemCount") return Number(album.count ?? album.itemCount ?? 0) || 0;
      return Number(album.updatedAt) || 0;
    };
    return [...albums].sort((a: any, b: any) => {
      const av = read(a);
      const bv = read(b);
      if (typeof av === "string") return mult * av.localeCompare(bv as string);
      return mult * ((av as number) - (bv as number));
    });
  }, [albums, albumsSort]);
  const cycleAlbumsSort = (key: AlbumsSortKey) =>
    setAlbumsSort((current) => {
      if (!current || current.key !== key) return { key, dir: "asc" };
      if (current.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  // The sort state belongs on the header cell (aria-sort), not on its button:
  // assistive tech reads which column is sorted and in which direction.
  const sortProps = (key: AlbumsSortKey) =>
    ({
      role: "columnheader",
      "aria-sort":
        albumsSort?.key !== key ? "none" : albumsSort.dir === "asc" ? "ascending" : "descending",
    }) as const;
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ id: string; before: boolean } | null>(null);
  // Cards render from a memo that preserves props order, so this is just the
  // current on-screen order.
  const albumOrderIds = albums.map((album: any) => album.id as string);

  const moveAlbum = (albumId: string, delta: number) => {
    const current = (props.albums || []).map((album: any) => album.id as string);
    const from = current.indexOf(albumId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= current.length) return;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    void reorderAlbums(next);
  };

  const reorderAlbum = (sourceId: string, targetId: string, before: boolean) => {
    const next = [...albumOrderIds];
    const from = next.indexOf(sourceId);
    if (from < 0) return;
    next.splice(from, 1);
    let to = next.indexOf(targetId);
    if (to < 0) return;
    if (!before) to += 1;
    next.splice(to, 0, sourceId);
    setDragId(null);
    setDropTarget(null);
    void reorderAlbums(next);
  };

  // Native HTML5 drag-and-drop does not deliver drops reliably inside macOS's
  // WebKit view, so the pointer is tracked at document level instead: a move
  // re-derives the target from elementFromPoint, a release applies it.
  const reorderAlbumRef = React.useRef(reorderAlbum);
  reorderAlbumRef.current = reorderAlbum;
  const dropTargetRef = React.useRef(dropTarget);
  dropTargetRef.current = dropTarget;

  const startAlbumDrag = (albumId: string, event: React.PointerEvent) => {
    // Prevent the native click on the grip: a drag must never open the album.
    event.preventDefault();
    setDragId(albumId);
  };

  React.useEffect(() => {
    if (!dragId) return;
    document.body.classList.add("is-dragging-albums");
    const onMove = (event: PointerEvent) => {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const wrap = element?.closest<HTMLElement>(".album-card-wrap");
      const id = wrap?.dataset.albumId ?? null;
      if (!wrap || !id || id === dragId) {
        dropTargetRef.current = null;
        setDropTarget(null);
        return;
      }
      const rect = wrap.getBoundingClientRect();
      const before = event.clientX < rect.left + rect.width / 2;
      dropTargetRef.current = { id, before };
      setDropTarget({ id, before });
    };
    const onUp = () => {
      const target = dropTargetRef.current;
      if (target) reorderAlbumRef.current(dragId, target.id, target.before);
      else {
        setDragId(null);
        setDropTarget(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDragId(null);
        setDropTarget(null);
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("is-dragging-albums");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [dragId]);

  // The film strip shows one row; "View all" expands it into the full
  // multi-row grid. Shown only when there is something to expand into.
  const smartAlbums = props.smartAlbums ?? [];
  const hasSmartAlbums = smartAlbums.length > 0;
  const [smartAlbumsExpanded, setSmartAlbumsExpanded] = React.useState(false);
  const canExpandSmartAlbums = smartAlbums.length > 4;
  const toggleSmartAlbumsExpanded = React.useCallback(() => {
    setSmartAlbumsExpanded((value) => !value);
  }, []);

  // The strip scrolls sideways with its scrollbar hidden, so a fade is the only
  // cue that more albums sit past the right edge. Track the scroll position
  // rather than assuming overflow: at the end of the row the fade has to go.
  const smartListRef = React.useRef<HTMLDivElement | null>(null);
  const [smartListHasMore, setSmartListHasMore] = React.useState(false);
  const syncSmartListOverflow = React.useCallback(() => {
    const list = smartListRef.current;
    if (!list) return;
    setSmartListHasMore(list.scrollWidth - list.clientWidth - list.scrollLeft > 4);
  }, []);

  React.useEffect(() => {
    syncSmartListOverflow();
    const list = smartListRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncSmartListOverflow);
    observer.observe(list);
    return () => observer.disconnect();
  }, [syncSmartListOverflow, props.smartAlbums, smartAlbumsExpanded]);

  return (
    <div className="feature-page albums-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">COLLECTIONS</p>
          <h1>Albums</h1>
          <p className="page-subtitle">
            {albums.length.toLocaleString()} {albums.length === 1 ? "album" : "albums"}
          </p>
        </div>
        <div className="header-actions">
          <div
            className="layout-switcher albums-view-switcher"
            role="group"
            aria-label="Albums layout"
          >
            <button
              type="button"
              aria-label="Card view"
              title="Card view"
              aria-pressed={albumsView === "cards"}
              className={albumsView === "cards" ? "selected" : ""}
              onClick={() => void updateSettings("albumsView", "cards")}
            >
              <GridIcon size={14} />
            </button>
            <button
              type="button"
              aria-label="List view"
              title="List view"
              aria-pressed={albumsView === "list"}
              className={albumsView === "list" ? "selected" : ""}
              onClick={() => void updateSettings("albumsView", "list")}
            >
              <DetailsIcon size={14} />
            </button>
          </div>
          <button className="primary-button" type="button" onClick={() => props.onCreateAlbum?.()}>
            <PlusIcon size={14} /> Create album
          </button>
        </div>
      </div>

      {/* The section exists to explain Smart Albums and to create one. When the
          page is entirely empty, the page-level empty state already offers both
          creates, so a second copy of the same panel would just repeat it. */}
      {(hasSmartAlbums || albums.length > 0) && (
        <section
          className={`smart-albums-section${smartAlbumsExpanded ? " is-expanded" : ""}${
            smartListHasMore ? " has-more" : ""
          }`}
          aria-label="Smart Albums"
        >
          <div className="smart-albums-headrow">
            <div className="smart-albums-heading-left">
              <h2>Smart Albums</h2>
              {hasSmartAlbums && (
                <span className="smart-albums-count">
                  {smartAlbums.length.toLocaleString()}{" "}
                  {smartAlbums.length === 1 ? "album" : "albums"}
                </span>
              )}
              <span className="smart-albums-toggle-desc">
                {hasSmartAlbums ? "Updates automatically" : "Saved filters that update themselves"}
              </span>
            </div>
            <div className="smart-albums-headactions">
              {canExpandSmartAlbums && (
                <button
                  type="button"
                  className="smart-albums-viewall"
                  onClick={toggleSmartAlbumsExpanded}
                  aria-pressed={smartAlbumsExpanded}
                >
                  {smartAlbumsExpanded ? "Show less" : "View all"}
                </button>
              )}
              <button
                type="button"
                className="smart-albums-new"
                onClick={() => props.onCreateSmartAlbum?.()}
              >
                <PlusIcon size={12} /> New smart album
              </button>
            </div>
          </div>
          {hasSmartAlbums ? (
            <div
              id="smart-albums-list"
              ref={smartListRef}
              className="smart-albums-list"
              role="list"
              aria-label="Smart albums"
              tabIndex={0}
              onScroll={syncSmartListOverflow}
            >
              {smartAlbums.map((album) => {
                const filter = album.filter;
                let badge = "📷";
                if (filter.kind === "video") badge = "▶️";
                else if (filter.kind === "raw") badge = "📷";
                else if (filter.favorite) badge = "❤️";
                else if (filter.query) badge = "🔍";
                else if (filter.tags?.length) badge = "🏷️";
                const coverPhotos = (album.coverItems ?? [])
                  .filter((item: any) => item.kind === "photo" || item.kind === "video")
                  .slice(0, 3);
                return (
                  <div className="smart-album-item" role="listitem" key={album.id}>
                    <button
                      type="button"
                      className="smart-album-tile"
                      onClick={() => props.onOpenSmartAlbum?.(album.id)}
                      onContextMenu={(e) => props.onSmartAlbumContextMenu?.(album, e)}
                      title={`Open ${album.name}`}
                    >
                      <span className="smart-album-tile-cover">
                        {coverPhotos.length ? (
                          <AlbumPhotoStack
                            photos={coverPhotos}
                            albumItems={album.coverItems ?? []}
                          />
                        ) : (
                          <span className="smart-album-tile-cover-empty">{badge}</span>
                        )}
                      </span>
                      <AlbumMeta name={album.name} count={formatAlbumCount(album.itemCount)} />
                    </button>
                    <div
                      className="album-card-actions smart-album-actions"
                      role="group"
                      aria-label={`${album.name} actions`}
                    >
                      <button
                        type="button"
                        className="album-card-action"
                        title="Edit Smart Album"
                        aria-label={`Edit ${album.name}`}
                        onClick={() => props.onEditSmartAlbum?.(album)}
                      >
                        <PencilIcon size={14} />
                      </button>
                      <button
                        type="button"
                        className="album-card-action is-danger"
                        title="Delete Smart Album"
                        aria-label={`Delete ${album.name}`}
                        onClick={() => props.onDeleteSmartAlbum?.(album)}
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="smart-albums-empty">
              Smart Albums are saved filters — they pick up new matches as your library changes.
              Build one here, or choose “Save as Smart Album” from the Library filter.
            </p>
          )}
        </section>
      )}

      {albums.length === 0 && (props.smartAlbums?.length ?? 0) === 0 ? (
        <div className="empty-state albums-empty">
          <span>
            <AlbumsIcon size={30} />
          </span>
          <b>No albums yet</b>
          <p>Create an album, then select photos in Library and choose Add to album.</p>
          <div className="empty-state-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => props.onCreateAlbum?.()}
            >
              <PlusIcon size={14} /> Create album
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => props.onCreateSmartAlbum?.()}
            >
              <SparkleIcon size={13} /> New smart album
            </button>
          </div>
        </div>
      ) : albumsView === "list" ? (
        <div className="albums-list-view" role="table">
          <div className="list-view-header" role="rowgroup">
            <div
              className="list-view-head-cell albums-col-grip"
              aria-hidden="true"
              role="columnheader"
            />
            <div
              className="list-view-head-cell albums-col-cover"
              aria-hidden="true"
              role="columnheader"
            />
            <div className="list-view-head-cell" {...sortProps("name")} role="columnheader">
              <button
                type="button"
                className="details-sort-header"
                onClick={() => cycleAlbumsSort("name")}
              >
                Name
                <span aria-hidden="true">
                  {albumsSort?.key === "name" ? (albumsSort.dir === "asc" ? "↑" : "↓") : "↕"}
                </span>
              </button>
            </div>
            <div
              className="list-view-head-cell list-view-head-cell--numeric"
              {...sortProps("itemCount")}
            >
              <button
                type="button"
                className="details-sort-header"
                onClick={() => cycleAlbumsSort("itemCount")}
              >
                Items
                <span aria-hidden="true">
                  {albumsSort?.key === "itemCount" ? (albumsSort.dir === "asc" ? "↑" : "↓") : "↕"}
                </span>
              </button>
            </div>
            <div
              className="list-view-head-cell list-view-head-cell--numeric"
              {...sortProps("itemSize")}
            >
              <button
                type="button"
                className="details-sort-header"
                onClick={() => cycleAlbumsSort("itemSize")}
              >
                Size
                <span aria-hidden="true">
                  {albumsSort?.key === "itemSize" ? (albumsSort.dir === "asc" ? "↑" : "↓") : "↕"}
                </span>
              </button>
            </div>
            <div className="list-view-head-cell" {...sortProps("updatedAt")}>
              <button
                type="button"
                className="details-sort-header"
                onClick={() => cycleAlbumsSort("updatedAt")}
              >
                Updated
                <span aria-hidden="true">
                  {albumsSort?.key === "updatedAt" ? (albumsSort.dir === "asc" ? "↑" : "↓") : "↕"}
                </span>
              </button>
            </div>
            <div className="list-view-head-cell albums-col-actions" role="columnheader" />
          </div>
          {/* The header must be a sibling of the rows, not a child of the
              .list-view grid: a sticky grid item is clipped to its own track,
              which left the Albums header unable to stick like the Library's. */}
          <div className="list-view" role="rowgroup">
            {sortedAlbums.map((album: any, index: number) => (
              <div
                className={`list-view-row album-list-row album-card-wrap${dragId === album.id ? " is-dragging" : ""}${
                  dropTarget && dropTarget.id === album.id
                    ? dropTarget.before
                      ? " is-drop-before"
                      : " is-drop-after"
                    : ""
                }`}
                key={album.id}
                role="row"
                data-album-id={album.id}
                onContextMenu={(e) => props.onAlbumContextMenu?.(album, e)}
              >
                <button
                  type="button"
                  className="tile-open-button"
                  role="gridcell"
                  aria-label={`Open ${album.name}`}
                  onClick={() => props.onOpenAlbum(album.id)}
                  onContextMenu={(e) => props.onAlbumContextMenu?.(album, e)}
                />
                <button
                  type="button"
                  className="albums-list-grip"
                  role="gridcell"
                  title={
                    albumsSort
                      ? "Sorting pauses manual ordering — pick Manual order (↕) to drag"
                      : "Drag to reorder"
                  }
                  aria-label={`Drag to reorder ${album.name}`}
                  style={{ touchAction: "none" }}
                  disabled={albumsSort !== null}
                  aria-disabled={albumsSort !== null}
                  onPointerDown={(event) => {
                    if (albumsSort !== null) return;
                    startAlbumDrag(album.id, event);
                  }}
                >
                  <DragIcon size={13} />
                </button>
                <span className="list-view-cell album-list-cover" role="gridcell">
                  {album.photos.length ? (
                    // A fanned stack instead of one print: the album rows should
                    // not read as a slimmer copy of the Library's item table.
                    <span className="album-list-cover-fan" aria-hidden="true">
                      {album.photos.map((photo: any) => (
                        <span key={photo.id} className="album-list-cover-fan-item">
                          <CachedThumbnail itemId={photo.id} name={album.name} size={64} />
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="album-list-cover-placeholder">
                      <AlbumsIcon size={18} />
                    </span>
                  )}
                </span>
                <span className="list-view-cell album-list-name" role="gridcell">
                  <i className={`album-dot ${album.color}`} aria-hidden="true" />
                  <MiddleTruncate
                    className="album-list-name-text"
                    text={album.name}
                    tailLength={6}
                  />
                </span>
                <span className="list-view-cell list-view-cell--numeric" role="gridcell">
                  {Number(album.count).toLocaleString()} {album.count === 1 ? "item" : "items"}
                </span>
                <span
                  className="list-view-cell list-view-cell--numeric list-view-cell--size"
                  role="gridcell"
                >
                  {formatBytesSimple(Number((album as any).itemSize ?? 0))}
                </span>
                <span className="list-view-cell list-view-cell--muted" role="gridcell">
                  {album.updatedAt ? formatFileDate(album.updatedAt) : "—"}
                </span>
                <div
                  className="album-card-actions album-list-actions"
                  role="gridcell"
                  aria-label={`${album.name} actions`}
                >
                  <button
                    type="button"
                    className="album-card-action"
                    title="Play slideshow"
                    aria-label={`Play slideshow of ${album.name}`}
                    onClick={() => props.onPlayAlbum?.(album.id)}
                  >
                    <SlideshowIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="album-card-action"
                    title="Add items"
                    aria-label={`Add items to ${album.name}`}
                    onClick={() => props.onAddItemsToAlbum?.(album.id)}
                  >
                    <PlusIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="album-card-action"
                    title="Move earlier"
                    aria-label={`Move ${album.name} earlier`}
                    disabled={albumsSort !== null || index === 0}
                    onClick={() => moveAlbum(album.id, -1)}
                  >
                    <ChevronUpIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="album-card-action"
                    title="Move later"
                    aria-label={`Move ${album.name} later`}
                    disabled={albumsSort !== null || index === albums.length - 1}
                    onClick={() => moveAlbum(album.id, 1)}
                  >
                    <ChevronDownIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="album-card-action"
                    title="Rename album"
                    aria-label={`Rename ${album.name}`}
                    onClick={() => props.onRenameAlbum?.(album)}
                  >
                    <PencilIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="album-card-action is-danger"
                    title="Delete album"
                    aria-label={`Delete ${album.name}`}
                    onClick={() => props.onDeleteAlbum?.(album)}
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="albums-grid">
          {albums.map((album: any, index: number) => (
            <div
              className={`album-card-wrap${dragId === album.id ? " is-dragging" : ""}${
                dropTarget && dropTarget.id === album.id
                  ? dropTarget.before
                    ? " is-drop-before"
                    : " is-drop-after"
                  : ""
              }`}
              key={album.id}
              data-album-id={album.id}
            >
              <button
                type="button"
                className="album-card-reorder"
                title="Drag to reorder"
                aria-label={`Drag to reorder ${album.name}`}
                style={{ touchAction: "none" }}
                onPointerDown={(event) => startAlbumDrag(album.id, event)}
              >
                <DragIcon size={13} />
              </button>
              <button
                type="button"
                className="album-card"
                onClick={() => props.onOpenAlbum(album.id)}
                onContextMenu={(e) => props.onAlbumContextMenu?.(album, e)}
                title={`Open ${album.name}`}
              >
                <span className={`album-cover ${album.photos.length ? "" : "is-empty"}`}>
                  {album.photos.length ? (
                    <AlbumPhotoStack photos={album.photos} albumItems={album.albumItems} />
                  ) : (
                    <span className="album-cover-placeholder">
                      <AlbumsIcon size={30} />
                    </span>
                  )}
                </span>
                <AlbumMeta
                  color={album.color}
                  name={album.name}
                  count={formatAlbumCount(album.count)}
                />
                {album.updatedAt ? (
                  <span className="album-updated">Updated {formatFileDate(album.updatedAt)}</span>
                ) : null}
              </button>
              <div className="album-card-actions" role="group" aria-label={`${album.name} actions`}>
                <button
                  type="button"
                  className="album-card-action"
                  title="Play slideshow"
                  aria-label={`Play slideshow of ${album.name}`}
                  onClick={() => props.onPlayAlbum?.(album.id)}
                >
                  <SlideshowIcon size={14} />
                </button>
                <button
                  type="button"
                  className="album-card-action"
                  title="Add items"
                  aria-label={`Add items to ${album.name}`}
                  onClick={() => props.onAddItemsToAlbum?.(album.id)}
                >
                  <PlusIcon size={14} />
                </button>
                <button
                  type="button"
                  className="album-card-action"
                  title="Move earlier"
                  aria-label={`Move ${album.name} earlier`}
                  disabled={albumsSort !== null || index === 0}
                  onClick={() => moveAlbum(album.id, -1)}
                >
                  <ChevronUpIcon size={14} />
                </button>
                <button
                  type="button"
                  className="album-card-action"
                  title="Move later"
                  aria-label={`Move ${album.name} later`}
                  disabled={albumsSort !== null || index === albums.length - 1}
                  onClick={() => moveAlbum(album.id, 1)}
                >
                  <ChevronDownIcon size={14} />
                </button>
                <button
                  type="button"
                  className="album-card-action"
                  title="Rename album"
                  aria-label={`Rename ${album.name}`}
                  onClick={() => props.onRenameAlbum?.(album)}
                >
                  <PencilIcon size={14} />
                </button>
                <button
                  type="button"
                  className="album-card-action is-danger"
                  title="Delete album"
                  aria-label={`Delete ${album.name}`}
                  onClick={() => props.onDeleteAlbum?.(album)}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            </div>
          ))}
          {albums.length === 0 && (
            <div className="albums-empty-inline">
              <p>No albums yet. Create one, then add photos from Library.</p>
              <button
                className="secondary-button"
                type="button"
                onClick={() => props.onCreateAlbum?.()}
              >
                <PlusIcon size={13} /> Create album
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default AlbumsScreen;
