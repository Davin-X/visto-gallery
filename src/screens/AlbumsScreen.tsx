import React from "react";
import { AlbumsIcon, PlusIcon } from "../design/components/icons";
import { AlbumPhotoStack } from "../design/components/AlbumPhotoStack";
import { MiddleTruncate } from "../design/components/MiddleTruncate";
import { useLibraryStore } from "../engine/stores/useLibraryStore";
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
  /** A stored album's accent. Smart albums have none: they are a saved filter,
   *  not an object with an identity, so the slot shows an empty ring. */
  color?: string;
  name: string;
  count: string;
}) {
  return (
    <span className="album-meta">
      <i className={color ? `album-dot ${color}` : "album-dot album-dot-ring"} aria-hidden="true" />
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

  // The film strip shows one row; "View all" expands it into the full
  // multi-row grid. Shown only when there is something to expand into.
  const [smartAlbumsExpanded, setSmartAlbumsExpanded] = React.useState(false);
  const canExpandSmartAlbums = (props.smartAlbums?.length ?? 0) > 4;
  const toggleSmartAlbumsExpanded = React.useCallback(() => {
    setSmartAlbumsExpanded((value) => !value);
  }, []);

  return (
    <div className="feature-page albums-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">COLLECTIONS</p>
          <h1>Albums</h1>
          <p className="page-subtitle">
            {albums.length.toLocaleString()} {albums.length === 1 ? "album" : "albums"} · Choose an
            album to see its photos.
          </p>
        </div>
        <div className="header-actions">
          <button className="primary-button" type="button" onClick={() => props.onCreateAlbum?.()}>
            <PlusIcon size={14} /> Create album
          </button>
        </div>
      </div>

      {(props.smartAlbums?.length ?? 0) > 0 && (
        <section
          className={`smart-albums-section${smartAlbumsExpanded ? " is-expanded" : ""}`}
          aria-label="Smart Albums"
        >
          <div className="smart-albums-headrow">
            <div className="smart-albums-heading-left">
              <span className="eyebrow">SAVED FILTERS</span>
              <h2>Smart Albums</h2>
              <span className="smart-albums-count">
                {props.smartAlbums!.length.toLocaleString()}
              </span>
              <span className="smart-albums-toggle-desc">Updates automatically</span>
            </div>
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
          </div>
          <div id="smart-albums-list" className="smart-albums-list">
            {props.smartAlbums!.map((album) => {
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
                <button
                  key={album.id}
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
                        assetUrl={props.assetUrl}
                        albumItems={album.coverItems ?? []}
                      />
                    ) : (
                      <span className="smart-album-tile-cover-empty">{badge}</span>
                    )}
                  </span>
                  <AlbumMeta name={album.name} count={formatAlbumCount(album.itemCount)} />
                </button>
              );
            })}
          </div>
        </section>
      )}

      {albums.length === 0 && (props.smartAlbums?.length ?? 0) === 0 ? (
        <div className="empty-state albums-empty">
          <span>
            <AlbumsIcon size={30} />
          </span>
          <b>No albums yet</b>
          <p>Create an album, then select photos in Library and choose Add to album.</p>
          <button className="primary-button" type="button" onClick={() => props.onCreateAlbum?.()}>
            <PlusIcon size={14} /> Create album
          </button>
        </div>
      ) : (
        <div className="albums-grid">
          {albums.map((album: any) => (
            <button
              key={album.id}
              type="button"
              className="album-card"
              onClick={() => props.onOpenAlbum(album.id)}
              onContextMenu={(e) => props.onAlbumContextMenu?.(album, e)}
              title={`Open ${album.name}`}
            >
              <span className={`album-cover ${album.photos.length ? "" : "is-empty"}`}>
                {album.photos.length ? (
                  <AlbumPhotoStack
                    photos={album.photos}
                    assetUrl={props.assetUrl}
                    albumItems={album.albumItems}
                  />
                ) : (
                  <span className="album-cover-placeholder">
                    <AlbumsIcon size={30} />
                    {album.count === 0 && <small>Empty</small>}
                  </span>
                )}
              </span>
              <AlbumMeta
                color={album.color}
                name={album.name}
                count={formatAlbumCount(album.count)}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default AlbumsScreen;
