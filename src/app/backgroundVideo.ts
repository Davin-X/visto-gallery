import type { MediaItem } from "../engine/types/media";

export function getAdjacentVideo(
  queue: MediaItem[],
  currentId: string | null,
  direction: -1 | 1,
): MediaItem | null {
  if (queue.length === 0) return null;
  const currentIndex = queue.findIndex((item) => item.id === currentId);
  if (currentIndex < 0) {
    return direction > 0 ? queue[0] : queue[queue.length - 1];
  }
  const nextIndex =
    (currentIndex + direction + queue.length) % queue.length;
  return queue[nextIndex];
}
