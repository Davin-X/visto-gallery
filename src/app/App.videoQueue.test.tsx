/// <reference types="vitest/globals" />
/**
 * Regression test for React error #185 ("Maximum update depth exceeded").
 *
 * The video-queue effect used to call setVideoQueue([]) with a fresh array
 * reference whenever the playback store still held an itemId while this App
 * instance had an empty local queue and no playable videos in scope. Because
 * `videoQueue` is in the effect's own dependency array, that created a new
 * reference on every run and React hit the nested-update limit.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

// Default to empty results for the library/settings commands App fires at
// mount; `get_library_stats` needs an object because the sidebar reads from
// it, so seed it with a zeroed LibraryStats.
const zeroStats = {
  photos: 0,
  videos: 0,
  raws: 0,
  animations: 0,
  uncategorized: 0,
  favorites: 0,
  hidden: 0,
  photoSize: 0,
  videoSize: 0,
  rawSize: 0,
  uncategorizedSize: 0,
  favoriteSize: 0,
  hiddenSize: 0,
  totalSize: 0,
};
const defaults: Record<string, unknown> = {
  get_library_stats: zeroStats,
  get_library_items: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
  get_album_overviews: [],
  get_albums: [],
  get_smart_albums: [],
  get_tags: [],
  get_library_folders: [],
  get_library_roots: [],
  supported_extensions: [],
  external_video_players: [],
  get_version: "0.0.0-test",
  check_updates: { available: false, currentVersion: "0.3.1", latestVersion: "0.3.1" },
  get_settings: {},
};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => Promise.resolve(command in defaults ? defaults[command] : [])),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
  save: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: vi.fn(() => Promise.resolve(null)),
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
    onResized: vi.fn(() => Promise.resolve(() => {})),
    onMoved: vi.fn(() => Promise.resolve(() => {})),
    setPosition: vi.fn(() => Promise.resolve()),
    setSize: vi.fn(() => Promise.resolve()),
    setBackgroundColor: vi.fn(() => Promise.resolve()),
    startDragging: vi.fn(() => Promise.resolve()),
  }),
  LogicalSize: class LogicalSize {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
  PhysicalPosition: class PhysicalPosition {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import App from "./App";
import { usePlaybackStore } from "../engine/stores/usePlaybackStore";
import { useLibraryStore } from "../engine/stores/useLibraryStore";

describe("startup video-queue effect", () => {
  beforeEach(() => {
    usePlaybackStore.setState({
      itemId: null,
      name: "",
      playing: false,
      time: 0,
      duration: 0,
      volume: 1,
      lastVolume: 1,
    });
    useLibraryStore.setState({
      items: [],
      viewerItems: [],
      visibleItems: [],
      sortedItems: [],
      playableItems: [],
      hiddenItems: [],
      refreshingLibrary: false,
    });
    Element.prototype.scrollTo = vi.fn() as unknown as Element["scrollTo"];
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  });

  afterEach(() => {
    cleanup();
  });

  test("does not enter an infinite update loop when playback is active with an empty viewer scope", async () => {
    render(<App />);
    // The playback store is module-level and can outlive an App remount
    // (e.g. an error boundary), so the store can hold an itemId while this
    // App instance has no queue and the view contains no playable videos.
    act(() => {
      usePlaybackStore.setState({ itemId: "ghost-video", name: "ghost.mp4", playing: true });
    });
    // Give any runaway effect a chance to throw.
    await act(async () => {});
    expect(screen.queryByText(/encountered an error/i)).toBeNull();
  });
});
