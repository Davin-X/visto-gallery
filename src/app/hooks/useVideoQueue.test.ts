// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useVideoQueue } from "./useVideoQueue";
import { useLibraryStore, usePlaybackStore } from "../../engine/stores";
import type { MediaItem } from "../../engine/types/media";

function makeVideo(id = "vid-1"): MediaItem {
  return {
    id,
    path: `/videos/${id}.mp4`,
    name: `${id}.mp4`,
    extension: "mp4",
    kind: "video",
    size: 1024,
    createdAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    capturedAt: null,
    width: 1920,
    height: 1080,
    favorite: false,
    hidden: false,
    isAnimated: false,
    rating: 0,
    colorLabel: null,
    tags: [],
    albumIds: [],
  };
}

describe("useVideoQueue.beginVideoSession", () => {
  it("resumes a paused same-session video instead of pausing it again", () => {
    const item = makeVideo("vid-1");
    useLibraryStore.setState({ items: [item], visibleItems: [item], viewerItems: [item] });

    const video = document.createElement("video");
    const playSpy = vi.fn().mockResolvedValue(undefined);
    const pauseSpy = vi.fn();
    Object.defineProperty(video, "paused", { configurable: true, get: () => true });
    video.play = playSpy;
    video.pause = pauseSpy;
    document.body.appendChild(video);

    usePlaybackStore.getState().register(video, { itemId: item.id, name: item.name });
    usePlaybackStore.getState().sync({ playing: false, duration: 10 });

    const { result } = renderHook(() => useVideoQueue());
    act(() => {
      result.current.beginVideoSession(item, "library");
    });

    expect(pauseSpy).not.toHaveBeenCalled();
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(video.dataset.allowPlay).toBeDefined();

    video.remove();
    usePlaybackStore.getState().stop();
  });

  it("rewinds an ended same-session video to 0 before playing", () => {
    const item = makeVideo("vid-2");
    useLibraryStore.setState({ items: [item], visibleItems: [item], viewerItems: [item] });

    const video = document.createElement("video");
    const playSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(video, "paused", { configurable: true, get: () => true });
    Object.defineProperty(video, "ended", { configurable: true, get: () => true });
    video.currentTime = 42;
    video.play = playSpy;
    document.body.appendChild(video);

    usePlaybackStore.getState().register(video, { itemId: item.id, name: item.name });

    const { result } = renderHook(() => useVideoQueue());
    act(() => {
      result.current.beginVideoSession(item, "library");
    });

    expect(video.currentTime).toBe(0);
    expect(playSpy).toHaveBeenCalledTimes(1);

    video.remove();
    usePlaybackStore.getState().stop();
  });

  it("marks playing true when reopening the same item without a mounted element", () => {
    const item = makeVideo("vid-3");
    useLibraryStore.setState({ items: [item], visibleItems: [item], viewerItems: [item] });

    const video = document.createElement("video");
    usePlaybackStore.getState().register(video, { itemId: item.id, name: item.name });
    usePlaybackStore.getState().sync({ playing: false, duration: 10 });
    usePlaybackStore.getState().unregister(video);

    const { result } = renderHook(() => useVideoQueue());
    act(() => {
      result.current.beginVideoSession(item, "library");
    });

    expect(usePlaybackStore.getState().playing).toBe(true);
    usePlaybackStore.getState().stop();
  });
});
