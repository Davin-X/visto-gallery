import type { RefObject } from "react";
import { CachedThumbnail } from "../../design/components/CachedThumbnail";
import { KindDot } from "../../design/components/KindBadge";
import type { DraftTransform } from "../../engine/stores/useEditStore";
import type { MediaItem } from "../../engine/types/media";
import { draftImageStyle } from "../../engine/utils/draftImage";

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
