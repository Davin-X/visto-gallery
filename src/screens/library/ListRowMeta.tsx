import { HeartIcon } from "../../design/components/icons";
import type { MediaItem } from "../../engine/types/media";

/**
 * Compact rating, favorite and color-label indicators for a list-view row.
 * Details rows carry dedicated columns for these; compact List rows pack
 * them inline at the end of the name cell instead.
 */
export function ListRowMeta({ item }: { item: MediaItem }) {
  const rating = Number(item.rating) || 0;
  if (!item.favorite && !item.colorLabel && rating === 0) return null;
  return (
    <span className="list-row-meta">
      {item.colorLabel ? (
        <i
          className={`list-row-color list-row-color--${item.colorLabel}`}
          role="img"
          aria-label={`Color label: ${item.colorLabel}`}
          title={`Color label: ${item.colorLabel}`}
        />
      ) : null}
      {item.favorite ? (
        <span className="list-row-favorite" role="img" aria-label="Favorite" title="Favorite">
          <HeartIcon size={11} filled />
        </span>
      ) : null}
      {rating > 0 ? (
        <span
          className="list-row-rating"
          role="img"
          aria-label={`Rating: ${rating} of 5 stars`}
          title={`Rating: ${rating} of 5 stars`}
        >
          <span className="star" aria-hidden="true">
            {"\u2605"}
          </span>
          {rating}
        </span>
      ) : null}
    </span>
  );
}
