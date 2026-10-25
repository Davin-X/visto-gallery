import { create } from "zustand";

/**
 * Mirrors the state of the video element that is currently mounted in the
 * viewer so a compact player can keep controlling it after the user leaves the
 * Viewer screen.
 *
 * The element itself is owned by `VideoPlayer`; this store only keeps a
 * reference plus the handful of fields the mini-player needs. Playback
 * continues because the video element stays mounted (the Viewer screen is
 * rendered off-screen instead of being unmounted when switching tabs).
 */
interface PlaybackSnapshot {
  itemId: string | null;
  name: string;
  playing: boolean;
  time: number;
  duration: number;
  muted: boolean;
  volume: number;
}

interface PlaybackState extends PlaybackSnapshot {
  element: HTMLVideoElement | null;

  register: (element: HTMLVideoElement, meta: { itemId: string; name: string }) => void;
  unregister: (element: HTMLVideoElement) => void;
  sync: (patch: Partial<PlaybackSnapshot>) => void;

  toggle: () => void;
  seek: (time: number) => void;
  toggleMute: () => void;
  stop: () => void;
}

export const usePlaybackStore = create<PlaybackState>()((set, get) => ({
  element: null,
  itemId: null,
  name: "",
  playing: false,
  time: 0,
  duration: 0,
  muted: false,
  volume: 1,

  register: (element, meta) =>
    set({ element, itemId: meta.itemId, name: meta.name }),

  unregister: (element) => {
    // A new video may have registered before the old one unmounted; only the
    // owner of the current reference is allowed to clear it.
    if (get().element !== element) return;
    set({
      element: null,
      itemId: null,
      name: "",
      playing: false,
      time: 0,
      duration: 0,
    });
  },

  sync: (patch) => set(patch),

  toggle: () => {
    const video = get().element;
    if (!video) return;
    if (video.paused) {
      // Pressing play on a finished video should restart it, not sit at the
      // final frame doing nothing.
      if (video.ended) video.currentTime = 0;
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  },

  seek: (time) => {
    const video = get().element;
    if (!video) return;
    video.currentTime = time;
    set({ time });
  },

  toggleMute: () => {
    const video = get().element;
    if (!video) return;
    video.muted = !video.muted;
    set({ muted: video.muted });
  },

  stop: () => {
    const video = get().element;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    set({
      element: null,
      itemId: null,
      name: "",
      playing: false,
      time: 0,
      duration: 0,
    });
  },
}));
