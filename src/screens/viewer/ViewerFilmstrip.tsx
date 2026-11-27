import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CachedThumbnail } from "../../design/components/CachedThumbnail";
import { KindDot } from "../../design/components/KindBadge";
import type { DraftTransform } from "../../engine/stores/useEditStore";
import type { MediaItem } from "../../engine/types/media";
import { draftImageStyle } from "../../engine/utils/draftImage";

const STRIP_WINDOW_SIZE = 50;

/** Manages filmstrip visibility, measured item stride, virtual windowing, and auto-scroll. */
export function useViewerFilmstrip({
  items,
  selectedId,
  selectedIndex,
  hasMore,
  onLoadMore,
}: {
  items: MediaItem[];
  selectedId: string | undefined;
  selectedIndex: number;
  hasMore?: boolean;
  onLoadMore?: () => unknown;
}) {
  const [filmstripOpen, setFilmstripOpen] = useState(true);
  const [stripStride, setStripStride] = useState(66);
  const [stripStart, setStripStart] = useState(() =>
    Math.max(0, items.findIndex((item) => item.id === selectedId) - STRIP_WINDOW_SIZE / 2),
  );
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stripStrideRef = useRef(stripStride);
  const stripStartRef = useRef(stripStart);
  const lastRevealedRef = useRef<string | null>(null);
  const loadMoreLockRef = useRef(false);
  const stripEnd = Math.min(items.length, stripStart + STRIP_WINDOW_SIZE);

  useLayoutEffect(() => {
    if (!filmstripOpen) return;
    const strip = stripRef.current;
    if (!strip) return;
    const button = strip.querySelector<HTMLElement>("button");
    const width = button?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    const gap = Number.parseFloat(window.getComputedStyle(strip).columnGap || "0") || 0;
    const stride = width + gap;
    if (Math.abs(stride - stripStrideRef.current) > 0.5) {
      stripStrideRef.current = stride;
      setStripStride(stride);
    }
  }, [items.length, filmstripOpen]);

  const maybeLoadMore = useCallback(() => {
    if (!hasMore || !onLoadMore || loadMoreLockRef.current) return;
    loadMoreLockRef.current = true;
    void Promise.resolve(onLoadMore()).finally(() => {
      loadMoreLockRef.current = false;
    });
  }, [hasMore, onLoadMore]);

  useEffect(() => {
    loadMoreLockRef.current = false;
  }, [items.length]);

  useEffect(() => {
    if (!filmstripOpen) {
      lastRevealedRef.current = null;
      return;
    }
    const strip = stripRef.current;
    if (!strip || selectedIndex < 0) return;
    const currentId = selectedId ?? null;
    const selectionChanged = lastRevealedRef.current !== currentId;
    lastRevealedRef.current = currentId;
    const stride = stripStrideRef.current;
    const maxStart = Math.max(0, items.length - STRIP_WINDOW_SIZE);
    let start = stripStartRef.current;
    const outsideWindow = selectedIndex < start || selectedIndex >= start + STRIP_WINDOW_SIZE;
    if (outsideWindow) {
      start = Math.max(0, Math.min(selectedIndex - Math.floor(STRIP_WINDOW_SIZE / 2), maxStart));
      stripStartRef.current = start;
      setStripStart(start);
    } else if (!selectionChanged) {
      return;
    }
    strip.scrollLeft = Math.max(
      0,
      selectedIndex * stride - Math.max(0, (strip.clientWidth - stride) / 2),
    );
  }, [selectedIndex, selectedId, items.length, filmstripOpen]);

  const handleFilmstripScroll = useCallback(() => {
    const strip = stripRef.current;
    if (!strip || items.length <= STRIP_WINDOW_SIZE) return;
    const stride = stripStrideRef.current;
    if (stride <= 0) return;
    const start = stripStartRef.current;
    const lead = 10;
    const first = Math.max(0, Math.floor(strip.scrollLeft / stride));
    const last = first + Math.ceil(strip.clientWidth / stride) + 1;
    if (last > items.length - 10) maybeLoadMore();
    let next = start;
    if (first < start + lead) {
      next = Math.max(0, first - lead);
    } else if (last > start + STRIP_WINDOW_SIZE - lead) {
      next = Math.min(
        Math.max(0, items.length - STRIP_WINDOW_SIZE),
        last - STRIP_WINDOW_SIZE + lead,
      );
    }
    if (next === start) return;
    stripStartRef.current = next;
    setStripStart(next);
  }, [items.length, maybeLoadMore]);

  return {
    filmstripOpen,
    setFilmstripOpen,
    stripRef,
    stripStart,
    stripEnd,
    stripStride,
    handleFilmstripScroll,
  };
}

export function ViewerFilmstrip({
  stripRef,
  onScroll,
  items,
  selectedId,
  stripStart,
  stripEnd,
  stripStride,
  draftTransforms,
  hasMore,
  loadingMore,
  onSelect,
  onLoadMore,
}: {
  stripRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  items: MediaItem[];
  selectedId: string | undefined;
  stripStart: number;
  stripEnd: number;
  stripStride: number;
  draftTransforms: Map<string, DraftTransform>;
  hasMore?: boolean;
  loadingMore?: boolean;
  onSelect: (id: string) => void;
  onLoadMore?: () => unknown;
}) {
  return (
    <div className="filmstrip" ref={stripRef} onScroll={onScroll}>
      {stripStart > 0 && (
        <span
          className="filmstrip-spacer"
          aria-hidden="true"
          style={{ flexBasis: `${stripStart * stripStride}px` }}
        />
      )}
      {items.slice(stripStart, stripEnd).map((item) => (
        <button
          type="button"
          title={item.name}
          className={item.id === selectedId ? "active" : ""}
          aria-current={item.id === selectedId ? "true" : undefined}
          key={item.id}
          onClick={() => onSelect(item.id)}
        >
          {item.kind === "photo" || item.kind === "raw" ? (
            <CachedThumbnail
              itemId={item.id}
              name={item.name}
              size={128}
              style={draftImageStyle(draftTransforms, item.id)}
            />
          ) : (
            <span>{item.extension.toUpperCase()}</span>
          )}
          <KindDot kind={item.kind} />
        </button>
      ))}
      {stripEnd < items.length && (
        <span
          className="filmstrip-spacer"
          aria-hidden="true"
          style={{ flexBasis: `${(items.length - stripEnd) * stripStride}px` }}
        />
      )}
      {hasMore ? (
        <button
          type="button"
          className="filmstrip-more"
          onClick={() => void onLoadMore?.()}
          disabled={loadingMore}
          aria-label="Load more photos"
          title="Load more photos into this strip"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
