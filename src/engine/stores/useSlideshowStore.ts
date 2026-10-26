import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { MediaItem } from "../types/media";

export type SlideshowTransition = "fade" | "slide" | "none";

interface SlideshowState {
  // A slideshow is an overlay session, not a screen. It owns its item list so
  // playing never mutates the library's selection or inspection state, and the
  // timer can be torn down cleanly when the overlay closes.
  isOpen: boolean;
  items: MediaItem[];
  index: number;
  playedCount: number;
  playing: boolean;
  interval: number; // seconds
  shuffle: boolean;
  loop: boolean;
  transition: SlideshowTransition;

  open: (items: MediaItem[], startId?: string | null) => void;
  close: () => void;
  next: () => void;
  previous: () => void;
  toggle: () => void;
  setInterval: (seconds: number) => void;
  setShuffle: (shuffle: boolean) => void;
  setLoop: (loop: boolean) => void;
  setTransition: (transition: SlideshowTransition) => void;
}

let slideshowTimer: ReturnType<typeof setInterval> | null = null;

function clearTimer() {
  if (slideshowTimer) {
    clearInterval(slideshowTimer);
    slideshowTimer = null;
  }
}

// Single timer owner: always clear before scheduling, so opening/restarting a
// slideshow can never stack intervals that outlive the overlay.
function schedule() {
  clearTimer();
  const { isOpen, playing, items, index, interval } =
    useSlideshowStore.getState();
  // Videos advance when playback ends; a fixed slide timer would cut off long
  // clips and skip short ones.
  if (items[index]?.kind === "video") return;
  if (!isOpen || !playing || items.length < 2) return;
  slideshowTimer = setInterval(
    () => {
      const state = useSlideshowStore.getState();
      if (!state.isOpen || !state.playing) return;
      state.next();
    },
    Math.max(1, interval) * 1000,
  );
}

export const useSlideshowStore = create<SlideshowState>()(
  devtools(
    (set, get) => ({
      isOpen: false,
      items: [],
      index: 0,
      playedCount: 0,
      playing: false,
      interval: 5,
      shuffle: false,
      loop: true,
      transition: "fade",

      open: (items, startId) => {
        if (items.length === 0) return;
        const start = startId
          ? items.findIndex((item) => item.id === startId)
          : -1;
        set({
          isOpen: true,
          items,
          index: start >= 0 ? start : 0,
          playedCount: 1,
          playing: true,
        });
        schedule();
      },

      close: () => {
        clearTimer();
        set({
          isOpen: false,
          items: [],
          index: 0,
          playedCount: 0,
          playing: false,
        });
      },

      next: () => {
        const { items, index, shuffle, loop, playedCount } = get();
        if (items.length < 2) return;
        if (!loop && playedCount >= items.length) {
          set({ playing: false });
          clearTimer();
          return;
        }
        let nextIndex = index;
        if (shuffle) {
          while (nextIndex === index)
            nextIndex = Math.floor(Math.random() * items.length);
        } else {
          nextIndex = (index + 1) % items.length;
        }
        set({ index: nextIndex, playedCount: playedCount + 1 });
        schedule();
      },

      previous: () => {
        const { items, index } = get();
        if (items.length < 2) return;
        set({ index: (index - 1 + items.length) % items.length });
        schedule();
      },

      toggle: () => {
        const playing = !get().playing;
        set({ playing });
        if (playing) schedule();
        else clearTimer();
      },

      setInterval: (seconds) => {
        set({ interval: Math.max(1, Math.min(60, seconds)) });
        if (get().isOpen && get().playing) schedule();
      },

      setShuffle: (shuffle) => set({ shuffle }),
      setLoop: (loop) => set({ loop }),
      setTransition: (transition) => set({ transition }),
    }),
    { name: "slideshow-store" },
  ),
);

// Cleanup on unload (the timer lives outside React).
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", clearTimer);
}
