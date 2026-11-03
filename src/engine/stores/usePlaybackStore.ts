import { create } from "zustand";

/**
 * Mirrors the state of the single video element so the audio-only Now Playing
 * card can control it while the dedicated player screen is in the background.
 *
 * The element itself is owned by `VideoPlayer`; this store only keeps a
 * reference plus the handful of fields the mini-player needs. Playback
 * continues because the dedicated player host stays mounted while playback is
 * active, including when a photo viewer is open.
 */
interface PlaybackSnapshot {
  itemId: string | null;
  name: string;
  playing: boolean;
  time: number;
  duration: number;
  muted: boolean;
  volume: number;
  lastVolume: number;
}

interface PlaybackState extends PlaybackSnapshot {
  element: HTMLVideoElement | null;

  register: (
    element: HTMLVideoElement,
    meta: { itemId: string; name: string },
  ) => void;
  unregister: (element: HTMLVideoElement) => void;
  sync: (patch: Partial<PlaybackSnapshot>) => void;
  setLastVolume: (volume: number) => void;

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
  lastVolume: 1,

  register: (element, meta) =>
    set((state) => ({
      element,
      itemId: meta.itemId,
      name: meta.name,
      // Re-registering the same item is a handoff between two mounted players
      // (foreground ↔ background); the snapshot must survive so playback
      // resumes where it left off. A different item starts a fresh snapshot.
      ...(state.itemId === meta.itemId
        ? {}
        : { playing: false, time: 0, duration: 0 }),
    })),

  unregister: (element) => {
    // A new video may have registered before the old one unmounted; only the
    // owner of the current reference is allowed to clear it.
    if (get().element !== element) return;
    // Keep the snapshot (item, position, playing state): the next player to
    // mount for this item resumes from it. stop() and registering another
    // item clear it.
    set({ element: null });
  },

  sync: (patch) => set(patch),

  setLastVolume: (volume) => set({ lastVolume: volume }),

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
