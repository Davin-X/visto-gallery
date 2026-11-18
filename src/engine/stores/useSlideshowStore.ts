import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { convertFileSrc } from "@tauri-apps/api/core";
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
  // Ambient audio is a presentation aid, not a library default: it is off by
  // default and only plays a track the user explicitly picked. The track is
  // stored in Settings, not in this session, so it survives a restart.
  ambientPath: string | null;
  ambientMuted: boolean;
  ambientVolume: number; // 0..1, independent of video volume
  // True when the current track could not be loaded/decoded. The path is kept
  // (so the user can see which track failed and re-pick) but playback stops.
  ambientError: boolean;

  open: (items: MediaItem[], startId?: string | null) => void;
  close: () => void;
  next: () => void;
  previous: () => void;
  toggle: () => void;
  setInterval: (seconds: number) => void;
  setShuffle: (shuffle: boolean) => void;
  setLoop: (loop: boolean) => void;
  setTransition: (transition: SlideshowTransition) => void;
  setAmbientPath: (path: string | null) => void;
  setAmbientMuted: (muted: boolean) => void;
  setAmbientVolume: (volume: number) => void;
}

let slideshowTimer: ReturnType<typeof setInterval> | null = null;
let ambientAudio: HTMLAudioElement | null = null;

function clearTimer() {
  if (slideshowTimer) {
    clearInterval(slideshowTimer);
    slideshowTimer = null;
  }
}

// Convert a local file path to a URL the webview's <audio> can load. A raw
// POSIX path resolves against tauri://localhost and 404s, so it must go through
// the asset protocol — the same conversion every other media surface uses.
function ambientUrl(path: string): string {
  if (!path) return "";
  if (path.startsWith("blob:") || path.startsWith("data:") || path.startsWith("http")) {
    return path;
  }
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

// The ambient track is a single shared element so it never stacks or restarts
// when the slide timer fires. It is paused on close and on unload.
function stopAmbient() {
  if (!ambientAudio) return;
  const audio = ambientAudio;
  ambientAudio = null;
  // Detach the error listener first: clearing src fires an "error" (empty src)
  // that would otherwise null the path asynchronously, after close() has run.
  audio.removeEventListener("error", handleAmbientError);
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

function handleAmbientError() {
  // Keep the path but stop retrying; surface the failure instead of silently
  // dropping the track (which made the controls vanish mid-show).
  useSlideshowStore.setState({ ambientError: true });
  ambientAudio?.pause();
}

function syncAmbient() {
  const { ambientPath, ambientMuted, ambientVolume, playing } = useSlideshowStore.getState();
  if (!ambientPath) {
    stopAmbient();
    return;
  }
  if (!ambientAudio) {
    ambientAudio = new Audio();
    ambientAudio.preload = "auto";
    ambientAudio.loop = true;
    ambientAudio.addEventListener("error", handleAmbientError);
  }
  const audio = ambientAudio;
  // Only (re)assign src when the underlying path changed. The resolved path is
  // stashed on the element so a volume/mute tweak does not restart the track —
  // comparing the resolved URL against the raw path would always differ.
  if (audio.dataset.path !== ambientPath) {
    audio.dataset.path = ambientPath;
    audio.src = ambientUrl(ambientPath);
    useSlideshowStore.setState({ ambientError: false });
  }
  audio.muted = ambientMuted;
  audio.volume = ambientVolume;
  if (playing && !useSlideshowStore.getState().ambientError) {
    audio.play().catch(() => {
      // Autoplay is gated by the browser; the toggle below is the fallback.
    });
  } else {
    audio.pause();
  }
}

// Single timer owner: always clear before scheduling, so opening/restarting a
// slideshow can never stack intervals that outlive the overlay.
function schedule() {
  clearTimer();
  const { isOpen, playing, items, index, interval } = useSlideshowStore.getState();
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
      ambientPath: null,
      ambientMuted: false,
      ambientVolume: 0.4,
      ambientError: false,

      open: (items, startId) => {
        if (items.length === 0) return;
        const start = startId ? items.findIndex((item) => item.id === startId) : -1;
        set({
          isOpen: true,
          items,
          index: start >= 0 ? start : 0,
          playedCount: 1,
          playing: true,
        });
        schedule();
        syncAmbient();
      },

      close: () => {
        clearTimer();
        stopAmbient();
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
          while (nextIndex === index) nextIndex = Math.floor(Math.random() * items.length);
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
        syncAmbient();
      },

      setInterval: (seconds) => {
        set({ interval: Math.max(1, Math.min(60, seconds)) });
        if (get().isOpen && get().playing) schedule();
      },

      setShuffle: (shuffle) => set({ shuffle }),
      setLoop: (loop) => set({ loop }),
      setTransition: (transition) => set({ transition }),
      setAmbientPath: (path) => {
        set({ ambientPath: path, ambientError: false });
        // Re-selecting the same track (e.g. after fixing the file) should retry,
        // so drop the loaded source and let syncAmbient assign it again.
        if (ambientAudio && ambientAudio.dataset.path === path) {
          ambientAudio.removeAttribute("src");
          delete ambientAudio.dataset.path;
          ambientAudio.load();
        }
        syncAmbient();
      },
      setAmbientMuted: (muted) => {
        set({ ambientMuted: muted });
        syncAmbient();
      },
      setAmbientVolume: (volume: number) => {
        set({ ambientVolume: Math.max(0, Math.min(1, volume)) });
        syncAmbient();
      },
    }),
    { name: "slideshow-store" },
  ),
);

// Cleanup on unload (the timer and audio element live outside React).
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    clearTimer();
    stopAmbient();
  });
}
