import { useEffect, useMemo, useRef, useState } from "react";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import { MapPinIcon, MinusIcon, PlusIcon } from "../design/components/icons";
import { events, tauri } from "../engine/commands/tauri";
import { useLibraryStore } from "../engine/stores/useLibraryStore";
import type { PhotoLocation } from "../engine/types/commands";
import type { MediaItem } from "../engine/types/media";
import { formatItemDate } from "../engine/utils/mediaDate";
import { drawAtlas } from "./map/atlas";
import { dateRange } from "./map/dates";
import {
  clustersInView,
  fitView,
  mapScale,
  moveMap,
  MAX_ZOOM,
  WORLD_VIEW,
  zoomAt,
} from "./map/geometry";
import "./map/map.css";

const PAGE_SIZE = 30;

function coordinate(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(3)}° ${value < 0 ? negative : positive}`;
}

export default function MapScreen({
  showErrorNotice,
  onOpenViewer,
}: {
  showErrorNotice: (error: unknown, prefix?: string) => void;
  onOpenViewer: (id: string) => void;
}) {
  const [photos, setPhotos] = useState<PhotoLocation[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState(WORLD_VIEW);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [group, setGroup] = useState<Set<string> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [opening, setOpening] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; view: typeof view } | null>(null);
  const dragFrame = useRef<number | null>(null);
  const dragPoint = useRef<{ x: number; y: number } | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    let active = true;
    let request = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const listeners: Array<() => void> = [];
    const load = async () => {
      const current = ++request;
      try {
        const result = await tauri.library.getPhotoLocations();
        if (!active || current !== request) return;
        const ids = new Set(result.map((photo) => photo.id));
        setPhotos(result);
        setGroup((prev) => {
          if (!prev) return null;
          const next = new Set([...prev].filter((id) => ids.has(id)));
          return next.size ? next : null;
        });
        setSelectedId((prev) => (prev && ids.has(prev) ? prev : null));
        setStatus("ready");
      } catch {
        if (active && current === request) setStatus("error");
      }
    };
    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void load(), 250);
    };
    for (const listen of [events.onLibraryChanged, events.onLibraryCountsChanged]) {
      void listen(refresh)
        .then((stop) => (active ? listeners.push(stop) : stop()))
        .catch(() => {});
    }
    void load();
    return () => {
      active = false;
      clearTimeout(refreshTimer);
      for (const stop of listeners) stop();
    };
  }, [retry]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
      setView((current) =>
        moveMap(current, current.latitude, current.longitude, { width, height }),
      );
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width || !size.height) return;
    const paint = () => drawAtlas(canvas, view, size);
    paint();
    const theme = new MutationObserver(paint);
    theme.observe(canvas.closest(".app-frame") ?? document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => theme.disconnect();
  }, [view, size]);

  // Open on the user's photos, not the whole world, once both are known.
  useEffect(() => {
    if (fitted.current || status !== "ready" || !size.width || !size.height) return;
    fitted.current = true;
    setView(fitView(photos, size));
  }, [status, photos, size]);

  // Native listener: React's wheel handler is passive and cannot stop page zoom.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      // Pinch arrives as ctrl+wheel with small deltas.
      const factor = Math.exp(-event.deltaY * lines * (event.ctrlKey ? 0.01 : 0.002));
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      setView((current) => zoomAt(current, factor, point, size));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [size]);

  const clusters = useMemo(() => clustersInView(photos, view, size), [photos, view, size]);
  // The rail follows the map: a clicked cluster, else whatever is in view.
  const groupPhotos = useMemo(() => {
    const ids = group ?? new Set(clusters.flatMap((cluster) => cluster.photos.map((p) => p.id)));
    return photos.filter((photo) => ids.has(photo.id));
  }, [photos, group, clusters]);
  const selected = photos.find((photo) => photo.id === selectedId);

  const showAll = () => {
    setGroup(null);
    setLimit(PAGE_SIZE);
    setView(fitView(photos, size));
  };

  const zoomBy = (factor: number) =>
    setView((current) => zoomAt(current, factor, { x: size.width / 2, y: size.height / 2 }, size));

  const selectPhoto = (photo: PhotoLocation) => {
    // Keep the list put while the map moves to the photo.
    if (!group) setGroup(new Set(groupPhotos.map((item) => item.id)));
    setSelectedId(photo.id);
    setView((current) =>
      moveMap(
        { ...current, zoom: Math.max(4, current.zoom) },
        photo.latitude,
        photo.longitude,
        size,
      ),
    );
  };

  /** Open the viewer on this photo; arrow keys step through the photos listed beside the map. */
  const openInViewer = async (id: string) => {
    setOpening(true);
    try {
      const found = await tauri.library.getItemsByIds(groupPhotos.map((photo) => photo.id));
      const byId = new Map(found.map((item) => [item.id, item]));
      const items = groupPhotos
        .map((photo) => byId.get(photo.id))
        .filter((item): item is MediaItem => !!item && !item.hidden && item.kind !== "video");
      if (!items.some((item) => item.id === id)) throw new Error("Photo is no longer available.");
      useLibraryStore.getState().setMapItems(items);
      onOpenViewer(id);
    } catch (error) {
      showErrorNotice(error, "Could not open photo");
    } finally {
      setOpening(false);
    }
  };

  const showInFinder = async (id: string) => {
    setOpening(true);
    try {
      const [item] = await tauri.library.getItemsByIds([id]);
      if (!item || item.hidden || item.kind === "video")
        throw new Error("Photo is no longer available.");
      await tauri.items.revealInFinder(item.path);
    } catch (error) {
      showErrorNotice(error, "Could not show photo in Finder");
    } finally {
      setOpening(false);
    }
  };

  const photosLabel = (count: number) =>
    `${count.toLocaleString()} ${count === 1 ? "photo" : "photos"}`;

  return (
    <section className="feature-page photo-map" aria-labelledby="photo-map-title">
      <header className="page-heading photo-map-heading">
        <h1 id="photo-map-title">Map</h1>
        <p>
          {status === "ready"
            ? `${photos.length.toLocaleString()} geotagged ${photos.length === 1 ? "photo" : "photos"}`
            : "Photo locations"}
        </p>
      </header>
      <div className="photo-map-layout">
        <div className="photo-map-atlas">
          <canvas
            ref={canvasRef}
            className={view.zoom > 1 ? "photo-map-canvas is-pannable" : "photo-map-canvas"}
            tabIndex={0}
            aria-label="World map. Use arrow keys to pan and plus or minus to zoom."
            onDoubleClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
              setView((current) => zoomAt(current, event.shiftKey ? 0.5 : 2, point, size));
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || view.zoom === 1) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { x: event.clientX, y: event.clientY, view };
            }}
            onPointerMove={(event) => {
              const origin = drag.current;
              if (!origin) return;
              dragPoint.current = { x: event.clientX, y: event.clientY };
              if (dragFrame.current !== null) return;
              dragFrame.current = requestAnimationFrame(() => {
                dragFrame.current = null;
                const point = dragPoint.current;
                if (!point || !drag.current) return;
                const scale = mapScale(size, origin.view.zoom);
                if (!scale) return;
                setView(
                  moveMap(
                    origin.view,
                    origin.view.latitude + (point.y - origin.y) / scale,
                    origin.view.longitude - (point.x - origin.x) / scale,
                    size,
                  ),
                );
              });
            }}
            onLostPointerCapture={() => {
              drag.current = null;
              dragPoint.current = null;
              if (dragFrame.current !== null) {
                cancelAnimationFrame(dragFrame.current);
                dragFrame.current = null;
              }
            }}
            onKeyDown={(event) => {
              if (event.metaKey || event.altKey || event.ctrlKey) return;
              if (event.key === "+" || event.key === "=" || event.key === "-") {
                event.preventDefault();
                zoomBy(event.key === "-" ? 0.5 : 2);
                return;
              }
              const step = 35 / view.zoom;
              const latitude =
                event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
              const longitude =
                event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
              if (!latitude && !longitude) return;
              event.preventDefault();
              setView(moveMap(view, view.latitude + latitude, view.longitude + longitude, size));
            }}
          />
          {status === "ready" &&
            clusters.map(({ x, y, photos: cluster }) => {
              const first = cluster[0];
              return (
                <button
                  key={first.id}
                  type="button"
                  className="photo-map-marker"
                  style={{ left: x, top: y }}
                  aria-label={
                    cluster.length === 1
                      ? first.name
                      : `${photosLabel(cluster.length)} in this area`
                  }
                  aria-pressed={cluster.some((photo) => photo.id === selectedId)}
                  onClick={() => {
                    setGroup(new Set(cluster.map((photo) => photo.id)));
                    setSelectedId(first.id);
                    setLimit(PAGE_SIZE);
                    // Zoom in so the cluster's photos spread out.
                    if (cluster.length > 1)
                      setView((current) => {
                        const next = fitView(cluster, size);
                        return next.zoom > current.zoom ? next : current;
                      });
                  }}
                >
                  <CachedThumbnail itemId={first.id} name="" size={128} eager />
                  {cluster.length > 1 && (
                    <span className="photo-map-count">{cluster.length.toLocaleString()}</span>
                  )}
                </button>
              );
            })}
          <div className="photo-map-controls" role="group" aria-label="Map controls">
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom in"
              title="Zoom in"
              disabled={view.zoom >= MAX_ZOOM}
              onClick={() => zoomBy(2)}
            >
              <PlusIcon size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom out"
              title="Zoom out"
              disabled={view.zoom <= 1}
              onClick={() => zoomBy(0.5)}
            >
              <MinusIcon size={17} />
            </button>
            <button
              type="button"
              className="quiet-button"
              disabled={view.zoom === 1}
              onClick={() => setView(WORLD_VIEW)}
            >
              World view
            </button>
          </div>
          <small className="photo-map-credit">Made with Natural Earth</small>
        </div>

        <aside aria-label="Map photos" className="photo-map-rail">
          {status === "loading" && <p role="status">Loading photo locations…</p>}
          {status === "error" && (
            <div className="photo-map-empty" role="alert">
              <p>Could not load photo locations.</p>
              <button
                type="button"
                className="quiet-button"
                onClick={() => {
                  setStatus("loading");
                  setRetry((value) => value + 1);
                }}
              >
                Try again
              </button>
            </div>
          )}
          {status === "ready" && !photos.length && (
            <div className="photo-map-empty">
              <MapPinIcon size={24} />
              <h2>No geotagged photos</h2>
              <p>Photos with GPS coordinates will appear here after import.</p>
            </div>
          )}
          {status === "ready" && photos.length > 0 && (
            <>
              <div className="photo-map-rail-heading">
                <div>
                  <h2>
                    {photosLabel(groupPhotos.length)} {group ? "here" : "in view"}
                  </h2>
                  {groupPhotos.length > 0 && <small>{dateRange(groupPhotos)}</small>}
                </div>
                {(group || groupPhotos.length < photos.length) && (
                  <button type="button" className="quiet-button" onClick={showAll}>
                    Show all
                  </button>
                )}
              </div>
              {selected && (
                <div className="photo-map-preview">
                  <div className="photo-map-preview-image">
                    <CachedThumbnail
                      key={selected.id}
                      itemId={selected.id}
                      name={selected.name}
                      size={512}
                      eager
                      showStatus
                    />
                  </div>
                  <h3 title={selected.name}>{selected.name}</h3>
                  <p>
                    {formatItemDate(selected)} · {coordinate(selected.latitude, "N", "S")},{" "}
                    {coordinate(selected.longitude, "E", "W")}
                  </p>
                  <div className="photo-map-preview-actions">
                    <button
                      type="button"
                      className="quiet-button"
                      disabled={opening}
                      onClick={() => void openInViewer(selected.id)}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className="quiet-button"
                      disabled={opening}
                      onClick={() => void showInFinder(selected.id)}
                    >
                      Show in Finder
                    </button>
                  </div>
                </div>
              )}
              <ul className="photo-map-grid">
                {groupPhotos.slice(0, limit).map((photo) => (
                  <li key={photo.id}>
                    <button
                      type="button"
                      onClick={() => selectPhoto(photo)}
                      aria-pressed={photo.id === selectedId}
                      aria-label={`${photo.name}, ${formatItemDate(photo)}`}
                      title={`${photo.name} · ${formatItemDate(photo)}`}
                    >
                      <CachedThumbnail itemId={photo.id} name="" size={128} />
                    </button>
                  </li>
                ))}
              </ul>
              {!groupPhotos.length && (
                <p className="photo-map-hint">No photos in this part of the map.</p>
              )}
              {groupPhotos.length > limit && (
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => setLimit((count) => count + PAGE_SIZE)}
                >
                  Show more
                </button>
              )}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
