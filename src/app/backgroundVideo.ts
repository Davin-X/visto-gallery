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

/**
 * Where the background player should live after one navigation step, and
 * whether the viewer should close.
 *
 * - Closing the viewer stops the background player for good.
 * - Inside the viewer a selected video owns playback; moving the selection
 *   from a video to a photo keeps that video playing behind the photo.
 * - Outside the viewer the last on-screen video keeps playing in the hidden
 *   viewer host; a photo with nothing playing closes the viewer as before.
 */
export function planBackgroundVideo(input: {
  isOpen: boolean;
  screen: string;
  selected: MediaItem | null;
  previous: MediaItem | null;
  current: MediaItem | null;
}): {
  background: MediaItem | null;
  previous: MediaItem | null;
  close: boolean;
} {
  if (!input.isOpen) {
    return { background: null, previous: null, close: false };
  }
  if (input.screen === "Viewer") {
    const { selected, previous, current } = input;
    if (selected?.kind === "video") {
      return { background: null, previous: selected, close: false };
    }
    if (previous?.kind === "video" && previous.id !== selected?.id) {
      return { background: previous, previous: selected, close: false };
    }
    return { background: current, previous: selected, close: false };
  }
  const { previous, current } = input;
  if (previous?.kind === "video") {
    return { background: previous, previous, close: false };
  }
  if (current) {
    return { background: current, previous, close: false };
  }
  return { background: null, previous, close: true };
}
