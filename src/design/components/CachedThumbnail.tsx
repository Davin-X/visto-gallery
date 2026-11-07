import React, { useState, useEffect, useRef } from "react";
import { tauri, thumbnailToDataUrl } from "../../engine/commands/tauri";
import { useSettingsStore } from "../../engine/stores/useSettingsStore";

// Shared, size- and quality-aware thumbnail cache. Both the editor picker and
// the library grid used to request multi-megabyte originals; cached JPEGs make
// scrolling a large library cheap. Keys include the size and quality because
// the backend caches each rendering separately. Byte-based eviction keeps the
// in-memory cache within maxCacheSizeGB.
const thumbnailCache = new Map<string, string>();
const thumbnailByteSizes = new Map<string, number>();
const thumbnailRequests = new Map<string, Promise<string>>();
const thumbnailQueue: Array<() => void> = [];
const MAX_CONCURRENT_THUMBNAIL_REQUESTS = 6;
type CachedThumbnailSize = 64 | 128 | 256 | 512 | 1024;
let activeThumbnailRequests = 0;
let cachedBytes = 0;

function maxCacheBytes(): number {
  return useSettingsStore.getState().maxCacheSizeGB * 1024 * 1024 * 1024;
}

function currentQuality(): number {
  return useSettingsStore.getState().thumbnailQuality;
}

// Shared state so one quality change clears the shared cache once, not once
// per mounted tile.
let lastClearedQuality: number | null = null;

/**
 * Drop every cached rendering for `itemId` so the next mount re-requests
 * from the backend (whose key includes `modified_at`). Call after an
 * in-place replace or a revert restores bytes at the same path — without
 * this the Map serves the stale data URL indefinitely.
 */
export function invalidateThumbnailCache(itemId: string): void {
  for (const key of [...thumbnailCache.keys()]) {
    if (key.startsWith(`${itemId}:`)) {
      const bytes = thumbnailByteSizes.get(key) ?? 0;
      thumbnailCache.delete(key);
      thumbnailByteSizes.delete(key);
      cachedBytes -= bytes;
    }
  }
}

function clearCacheForQuality(quality: number): void {
  if (lastClearedQuality === quality) return;
  lastClearedQuality = quality;
  if (thumbnailCache.size > 0) {
    thumbnailCache.clear();
    thumbnailByteSizes.clear();
    cachedBytes = 0;
  }
}

function cacheKey(itemId: string, size: CachedThumbnailSize): string {
  return `${itemId}:${size}:${currentQuality()}`;
}

function evictByBytes(targetBytes: number): void {
  while (cachedBytes > targetBytes && thumbnailCache.size > 0) {
    const oldestKey = thumbnailCache.keys().next().value;
    if (!oldestKey) break;
    const evictedBytes = thumbnailByteSizes.get(oldestKey) ?? 0;
    thumbnailCache.delete(oldestKey);
    thumbnailByteSizes.delete(oldestKey);
    cachedBytes -= evictedBytes;
  }
}

function loadThumbnail(itemId: string, size: CachedThumbnailSize): Promise<string> {
  const key = cacheKey(itemId, size);
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
          quality: currentQuality(),
          maxCacheBytes: maxCacheBytes(),
        })
        .then((response: any) => {
          const url = thumbnailToDataUrl(response);
          const byteSize = new TextEncoder().encode(url).byteLength;
          thumbnailCache.set(key, url);
          thumbnailByteSizes.set(key, byteSize);
          cachedBytes += byteSize;
          // Evict by byte size (LRU).
          evictByBytes(maxCacheBytes() * 0.9);
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
  // Subscribe so a quality change clears the shared cache exactly once,
  // instead of every mounted tile clearing it on mount.
  const thumbnailQuality = useSettingsStore((s) => s.thumbnailQuality);
  const requestKey = cacheKey(itemId, size);
  // Never paint a thumbnail for a previous item or size while the new request
  // is in flight (e.g. switching the grid density or layout).
  const src = loaded?.key === requestKey ? loaded.src : null;
  const failed = failedKey === requestKey;

  // Clear the shared cache when quality actually changes so stale thumbnails
  // are not served. Subscribes to the setting instead of reading it once, and
  // clears exactly once per change (not once per mounted tile).
  useEffect(() => {
    clearCacheForQuality(thumbnailQuality);
  }, [thumbnailQuality]);

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
    const root = placeholder.closest(
      ".library-grid-container, .edit-picker-grid, .duplicates-page",
    );
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
