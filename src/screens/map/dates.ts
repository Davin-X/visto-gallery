import type { PhotoLocation } from "../../engine/types/commands";
import { formatItemDate, itemTimestamp } from "../../engine/utils/mediaDate";

/** "Mar 4, 2024 – Jun 18, 2025". File dates count only when no photo has a capture date. */
export function dateRange(photos: PhotoLocation[]): string {
  const dated = photos.filter((photo) => photo.capturedAt != null);
  const pool = dated.length ? dated : photos;
  if (!pool.length) return "";
  let [oldest, newest] = [pool[0], pool[0]];
  for (const photo of pool) {
    const ms = itemTimestamp(photo).ms;
    if (ms < itemTimestamp(oldest).ms) oldest = photo;
    if (ms > itemTimestamp(newest).ms) newest = photo;
  }
  const [from, to] = [formatItemDate(oldest), formatItemDate(newest)];
  return from === to ? from : `${from} – ${to}`;
}
