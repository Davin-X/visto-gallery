import React, { useState, useEffect, useRef } from "react";
import { tauri } from "../../engine/commands/tauri";

// Shared, size-aware thumbnail cache. Both the editor picker and the library
// grid used to request multi-megabyte originals; cached JPEGs make scrolling a
// large library cheap. Keys include the size because the backend caches each
// rendering separately.
const thumbnailCache = new Map<string, { dataUrl: string; byteLength: number }>();
const thumbnailRequests = new Map<string, Promise<string>>();
const thumbnailQueue: Array<() => void> = [];
// Byte budget: 20 MiB ≈ 256 * 80 KB (1024px JPEG). Evict by bytes, not count.
const THUMBNAIL_CACHE_LIMIT_BYTES = 20 * 1024 * 1024;
const MAX_CONCURRENT_THUMBNAIL_REQUESTS = 6;
type CachedThumbnailSize = 64 | 128 | 256 | 512 | 1024;
let activeThumbnailRequests = 0;
let thumbnailCacheBytes = 0;

function loadThumbnail(itemId: string, size: CachedThumbnailSize): Promise<string> {
  const key = `${itemId}:${size}`;
  const cached = thumbnailCache.get(key);
  if (cached) {
    // Refresh insertion order so the least recently used entry is evicted first.
    thumbnailCache.delete(key);
    thumbnailCache.set(key, cached);
    return Promise.resolve(cached.dataUrl);
  }
  const inFlight = thumbnailRequests.get(key);
  if (inFlight) return inFlight;

  const request = new Promise<string>((resolve, reject) => {
    thumbnailQueue.push(() => {
      activeThumbnailRequests += 1;
      void tauri.library.getThumbnail({ itemId, size }).then((response: any) => {
        const byteLength = response.dataUrl.length; // base64 length ≈ 4/3 * bytes
        thumbnailCache.set(key, { dataUrl: response.dataUrl, byteLength });
        thumbnailCacheBytes += byteLength;
        // Evict by bytes, not count
        while (thumbnailCacheBytes > THUMBNAIL_CACHE_LIMIT_BYTES && thumbnailCache.size > 0) {
          const oldestKey = thumbnailCache.keys().next().value;
          if (oldestKey) {
            const oldest = thumbnailCache.get(oldestKey);
            if (oldest) thumbnailCacheBytes -= oldest.byteLength;
            thumbnailCache.delete(oldestKey);
          } else {
            break;
          }
        }
        resolve(response.dataUrl);
      }).catch(reject).finally(() => {
        thumbnailRequests.delete(key);
        activeThumbnailRequests -= 1;
        while (activeThumbnailRequests < MAX_CONCURRENT_THUMBNAIL_REQUESTS && thumbnailQueue.length) {
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
}: {
  itemId: string;
  name: string;
  size: CachedThumbnailSize;
  style?: React.CSSProperties;
  showStatus?: boolean;
  placeholderClassName?: string;
  fallbackSrc?: string;
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
    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    // Scrollable panels clip their contents, so observing against the viewport
    // would ignore the prefetch margin. Use the nearest panel as the root.
    const root = placeholder.closest(".library-grid-container, .edit-picker-grid");
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { root, rootMargin: "240px" });
    observer.observe(placeholder);
    return () => observer.disconnect();
  }, [itemId, size]);

  useEffect(() => {
    if (!nearViewport) return;
    let current = true;
    loadThumbnail(itemId, size).then((value) => {
      if (current) setLoaded({ key: requestKey, src: value });
    }).catch(() => {
      if (current) setFailedKey(requestKey);
    });
    return () => { current = false; };
  }, [itemId, size, nearViewport, requestKey]);

  if (failed && fallbackSrc) {
    return <img src={fallbackSrc} alt={name} loading="lazy" decoding="async" style={style} />;
  }
  if (src) {
    return <img src={src} alt={name} loading="lazy" decoding="async" fetchPriority="low" style={style} />;
  }
  return (
    <span
      ref={placeholderRef}
      className={`cached-thumb-placeholder${failed ? " is-failed" : " is-loading"}${placeholderClassName ? ` ${placeholderClassName}` : ""}`}
      aria-hidden="true"
    >
      {showStatus ? (failed ? "Preview unavailable" : nearViewport ? "Loading preview…" : "") : null}
    </span>
  );
}


export { CachedThumbnail };
