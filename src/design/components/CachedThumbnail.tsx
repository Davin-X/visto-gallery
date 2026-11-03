import React, { useState, useEffect, useRef } from "react";
import { tauri, thumbnailToDataUrl } from "../../engine/commands/tauri";
import { useSettingsStore } from "../../engine/stores/useSettingsStore";

// Shared, size-aware thumbnail cache. Both the editor picker and the library
// grid used to request multi-megabyte originals; cached JPEGs make scrolling a
// large library cheap. Keys include the size because the backend caches each
// rendering separately.
const thumbnailCache = new Map<string, string>();
const thumbnailRequests = new Map<string, Promise<string>>();
const thumbnailQueue: Array<() => void> = [];
const THUMBNAIL_CACHE_LIMIT_ENTRIES = 512;
const MAX_CONCURRENT_THUMBNAIL_REQUESTS = 6;
type CachedThumbnailSize = 64 | 128 | 256 | 512 | 1024;
let activeThumbnailRequests = 0;

function loadThumbnail(itemId: string, size: CachedThumbnailSize): Promise<string> {
  const key = `${itemId}:${size}`;
  const cached = thumbnailCache.get(key);
  if (cached) {
    // Refresh insertion order so the least recently used entry is evicted first.
    thumbnailCache.delete(key);
    thumbnailCache.set(key, cached);
    return Promise.resolve(cached);
  }
  const inFlight = thumbnailRequests.get(key);
  if (inFlight) return inFlight;

  const request = new Promise<string>((resolve, reject) => {
    thumbnailQueue.push(() => {
      activeThumbnailRequests += 1;
      void tauri.library
        .getThumbnail({
          itemId,
          size,
          quality: useSettingsStore.getState().thumbnailQuality,
          maxCacheBytes: useSettingsStore.getState().maxCacheSizeGB * 1024 * 1024 * 1024,
        })
        .then((response: any) => {
          const url = thumbnailToDataUrl(response);
          thumbnailCache.set(key, url);
          // Evict by count (LRU).
          while (thumbnailCache.size > THUMBNAIL_CACHE_LIMIT_ENTRIES) {
            const oldestKey = thumbnailCache.keys().next().value;
            if (oldestKey) thumbnailCache.delete(oldestKey);
            else break;
          }
          resolve(url);
        })
        .catch(reject)
        .finally(() => {
          thumbnailRequests.delete(key);
          activeThumbnailRequests -= 1;
          while (
            activeThumbnailRequests < MAX_CONCURRENT_THUMBNAIL_REQUESTS &&
            thumbnailQueue.length
          ) {
            thumbnailQueue.shift()?.();
          }
        });
    });
  });
  thumbnailRequests.set(key, request);
  while (activeThumbnailRequests < MAX_CONCURRENT_THUMBNAIL_REQUESTS && thumbnailQueue.length) {
    thumbnailQueue.shift()?.();
  }
  return request;
}

function CachedThumbnail({
  itemId,
  name,
  size,
  style,
  showStatus = false,
  placeholderClassName,
  fallbackSrc,
  eager = false,
}: {
  itemId: string;
  name: string;
  size: CachedThumbnailSize;
  style?: React.CSSProperties;
  showStatus?: boolean;
  placeholderClassName?: string;
  fallbackSrc?: string;
  eager?: boolean;
}) {
  const placeholderRef = useRef<HTMLSpanElement | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; src: string } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const requestKey = `${itemId}:${size}`;
  // Never paint a thumbnail for a previous item or size while the new request
  // is in flight (e.g. switching the grid density or layout).
  const src = loaded?.key === requestKey ? loaded.src : null;
  const failed = failedKey === requestKey;

  useEffect(() => {
    if (eager) {
      setNearViewport(true);
      return;
    }
    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    // Scrollable panels clip their contents, so observing against the viewport
    // would ignore the prefetch margin. Use the nearest panel as the root.
    const root = placeholder.closest(".library-grid-container, .edit-picker-grid");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { root, rootMargin: "240px" },
    );
    observer.observe(placeholder);
    return () => observer.disconnect();
  }, [itemId, size, eager]);

  useEffect(() => {
    if (!nearViewport && !eager) return;
    let current = true;
    loadThumbnail(itemId, size)
      .then((value) => {
        if (current) setLoaded({ key: requestKey, src: value });
      })
      .catch(() => {
        if (current) setFailedKey(requestKey);
      });
    return () => {
      current = false;
    };
  }, [itemId, size, nearViewport, requestKey, eager]);

  if (failed && fallbackSrc) {
    return (
      <img
        src={fallbackSrc}
        alt={name}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        style={style}
      />
    );
  }
  if (src) {
    return (
      <img src={src} alt={name} loading={eager ? "eager" : "lazy"} decoding="async" style={style} />
    );
  }
  return (
    <span
      ref={placeholderRef}
      className={`cached-thumb-placeholder${failed ? " is-failed" : " is-loading"}${placeholderClassName ? ` ${placeholderClassName}` : ""}`}
      aria-hidden="true"
    >
      {showStatus
        ? failed
          ? "Preview unavailable"
          : nearViewport
            ? "Loading preview…"
            : ""
        : null}
    </span>
  );
}

export { CachedThumbnail };
