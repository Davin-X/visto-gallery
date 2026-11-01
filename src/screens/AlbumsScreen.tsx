import React, { useEffect } from "react";
import { AlbumsIcon, PlusIcon } from "../design/components/icons";
import { AlbumPhotoStack } from "../design/components/AlbumPhotoStack";
import { useLibraryStore } from "../engine/stores/useLibraryStore";
import type { Album, MediaItem, MediaKind } from "../engine/types/media";

interface AlbumsScreenProps {
  albums: Album[];
  items: MediaItem[];
  assetUrl: (path: string) => string;
  onCreateAlbum: () => void;
  onAlbumContextMenu: (album: any, e: React.MouseEvent) => void;
  onOpenAlbum: (albumId: string) => void;
  onOpenSmartAlbum: (kind: "rating" | "color", value: number | string) => void;
}

function AlbumsScreen(props: AlbumsScreenProps) {
  const library = useLibraryStore();
  const loadAlbumItems = library.loadAlbumItems;
  const albumItemsCache = library.albumItems;

  const [loadedAlbumIds, setLoadedAlbumIds] = React.useState<Set<string>>(
    new Set(),
  );

  // Load items for each album that hasn't been loaded yet
  useEffect(() => {
    const loadPromises = (props.albums || [])
      .filter((album: any) => !loadedAlbumIds.has(album.id))
      .map((album: any) => loadAlbumItems(album.id));

    if (loadPromises.length > 0) {
      Promise.all(loadPromises).then(() => {
        setLoadedAlbumIds((prev) => {
          const next = new Set(prev);
          (props.albums || []).forEach((a: any) => next.add(a.id));
          return next;
        });
      });
    }
  }, [props.albums, loadAlbumItems, loadedAlbumIds]);

  const albums = React.useMemo(
    () =>
      (props.albums || []).map((album: any, index: number) => {
        // Use loaded album items from store (complete catalog), not paginated
        // props.items which would miss items on non-loaded pages.
        const albumItems: MediaItem[] =
          albumItemsCache[album.id] ||
          (props.items || []).filter(
            (item: any) =>
              (album.itemIds || []).includes(item.id) && !item.hidden,
          );
        // Skip RAW-only files for the cover fan; they have no poster frame.
        const photos = albumItems
          .filter(
            (item: any) => item.kind === "photo" || item.kind === "video",
          )
          .slice(0, 3);
        return {
          ...album,
          photos,
          albumItems,
          count: Number(album.itemCount),
          color: ["coral", "violet", "blue", "green"][index % 4],
        };
      }),
    [props.albums, props.items, albumItemsCache, loadedAlbumIds],
  );

  return (
    <div className="feature-page albums-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">COLLECTIONS</p>
          <h1>Albums</h1>
          <p className="page-subtitle">
            {albums.length.toLocaleString()}{" "}
            {albums.length === 1 ? "album" : "albums"} · Choose an album to see
            its photos.
          </p>
        </div>
      </div>

      {albums.length === 0 ? (
        <div className="empty-state albums-empty">
          <span>
            <AlbumsIcon size={30} />
          </span>
          <b>No albums yet</b>
          <p>
            Create an album, then select photos in Library and choose Add to
            album.
          </p>
          <button
            className="primary-button"
            type="button"
            onClick={() => props.onCreateAlbum?.()}
          >
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
              <span
                className={`album-cover ${album.photos.length ? "" : "is-empty"}`}
              >
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
                  <span>{album.name}</span>
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

      {/* Smart Collections */}
      <div className="page-heading">
        <div>
          <p className="eyebrow">SMART COLLECTIONS</p>
          <h1>Smart Albums</h1>
          <p className="page-subtitle">
            Filter by rating or color label across your library.
          </p>
        </div>
      </div>
      <div className="smart-albums-grid">
        <h2 className="smart-section-title">By Rating</h2>
        <div className="smart-rating-row">
          {[1, 2, 3, 4, 5].map((stars) => (
            <button
              key={stars}
              type="button"
              className="smart-card smart-card-rating"
              onClick={() =>
                props.onOpenSmartAlbum("rating", stars)
              }
              title={`Show ${stars}+ star${stars > 1 ? "s" : ""} photos`}
            >
              <span className="smart-card-label">
                {Array.from({ length: stars }).map(() => (
                  <span key="star" className="star filled">
                    {"\u2605"}
                  </span>
                ))}
                {Array.from({ length: 5 - stars }).map(() => (
                  <span key="empty" className="star">
                    {"\u2605"}
                  </span>
                ))}
              </span>
              <span className="smart-card-count">{stars}+</span>
            </button>
          ))}
        </div>
        <h2 className="smart-section-title">By Color Label</h2>
        <div className="smart-color-row">
          {([
            ["red", "Red", "#ef4444"],
            ["yellow", "Yellow", "#eab308"],
            ["green", "Green", "#22c55e"],
            ["blue", "Blue", "#3b82f6"],
            ["purple", "Purple", "#a855f7"],
          ] as [string, string, string][]).map(([color, name, hex]) => (
            <button
              key={color}
              type="button"
              className={`smart-card smart-card-color smart-card-color-${color}`}
              onClick={() =>
                props.onOpenSmartAlbum("color", color)
              }
              title={`Show ${name} labeled photos`}
            >
              <span
                className="smart-color-dot"
                style={{ backgroundColor: hex }}
              />
              <span className="smart-card-label">{name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

async function createMediaItemsBrowser(
  files: FileList | File[],
): Promise<MediaItem[]> {
  const items: MediaItem[] = [];
  for (const file of Array.from(files)) {
    if (!file.name || file.name.startsWith(".")) continue;
    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;
    const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
    const videoExts = new Set(["m4v", "mov", "mp4", "mpeg", "mpg", "webm"]);
    const rawExts = new Set([
      "arw",
      "cr2",
      "cr3",
      "dng",
      "nef",
      "raf",
      "raw",
      "rw2",
    ]);
    const imageExts = new Set([
      "avif",
      "bmp",
      "gif",
      "heic",
      "heif",
      "jpeg",
      "jpg",
      "png",
      "tif",
      "tiff",
      "webp",
    ]);
    // "unsupported" is a sentinel for "no known kind" - it is not a MediaKind.
    let kind: MediaKind | "unsupported" = "unsupported";
    if (videoExts.has(ext)) kind = "video";
    else if (rawExts.has(ext)) kind = "raw";
    else if (imageExts.has(ext)) kind = "photo";
    if (kind === "unsupported") continue;

    const url = URL.createObjectURL(file);
    let width: number | undefined;
    let height: number | undefined;
    if (kind === "photo") {
      const img = new Image();
      await new Promise<void>((resolve) => {
        img.onload = () => {
          width = img.naturalWidth;
          height = img.naturalHeight;
          resolve();
        };
        img.onerror = () => resolve();
        img.src = url;
      });
      if (!width || !height) {
        // Could not read the dimensions - treat as unsupported and skip.
        URL.revokeObjectURL(url);
        continue;
      }
    }

    items.push({
      id: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`,
      // Browser has no real absolute path; keep a session-relative stand-in.
      path: relativePath,
      name: file.name,
      extension: ext,
      kind,
      size: file.size,
      modifiedAt: file.lastModified,
      // In-memory import: the browser exposes no true capture time or camera
      // data, so fall back to the file's mtime for ordering.
      capturedAt: file.lastModified,
      width,
      height,
      favorite: false,
      hidden: false,
      tags: [],
      albumIds: [],
      createdAt: file.lastModified,
      updatedAt: file.lastModified,
    });
  }
  return items;
}

export default AlbumsScreen;
