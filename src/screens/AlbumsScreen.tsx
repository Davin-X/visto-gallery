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
      </div>

      {(props.smartAlbums?.length ?? 0) > 0 && (
        <section className="smart-albums-section" aria-label="Smart Albums">
          <div className="smart-albums-heading">
            <div className="page-heading--section">
              <p className="eyebrow">SAVED FILTERS</p>
              <h2>Smart Albums</h2>
            </div>
            <span className="section-desc">Updates automatically as your library changes.</span>
          </div>
          <div className="smart-albums-list">
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
                  <MiddleTruncate
                    className="smart-album-tile-name"
                    text={album.name}
                    tailLength={6}
                  />
                  <span className="smart-album-tile-count">
                    {formatAlbumCount(album.itemCount)}
                  </span>
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
              <span className="album-card-meta">
                <span className="album-card-name">
                  <i className={`album-dot ${album.color}`} />
                  {/* Names often differ only at the end ("Trip 2023", "Trip
                      2024"), so keep the end visible when space runs out. */}
                  <MiddleTruncate text={album.name} tailLength={6} />
                </span>
                <span className="album-card-count">
                  {album.count > 0
                    ? `${album.count.toLocaleString()} ${album.count === 1 ? "item" : "items"}`
                    : "Empty"}
                </span>
              </span>
            </button>
          ))}
          <button
            type="button"
            className="album-card album-card-add"
            onClick={() => props.onCreateAlbum?.()}
            aria-label="Create new album"
          >
            <span className="album-cover-add">
              <PlusIcon size={28} />
            </span>
            <span className="album-card-meta">
              <span className="album-card-name">New album</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

export default AlbumsScreen;
