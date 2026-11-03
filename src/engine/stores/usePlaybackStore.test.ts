/// <reference types="vitest/globals" />
import { beforeEach, describe, expect, test, vi } from "vitest";
import { usePlaybackStore } from "./usePlaybackStore";

function fakeVideo() {
  return {
    paused: true,
    currentTime: 0,
    volume: 1,
    muted: false,
    pause: vi.fn(),
    play: vi.fn(async () => {}),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  } as unknown as HTMLVideoElement;
}

describe("playback snapshot handoff", () => {
  beforeEach(() => {
    usePlaybackStore.getState().stop();
  });

  const startVideoA = () => {
    const first = fakeVideo();
    usePlaybackStore.getState().register(first, {
      itemId: "video-a",
      name: "A.mp4",
    });
    usePlaybackStore.getState().sync({
      playing: true,
      time: 12,
      duration: 60,
    });
    usePlaybackStore.getState().unregister(first);
    return first;
  };

  test("unregistering keeps the snapshot for the next player", () => {
    startVideoA();
    const state = usePlaybackStore.getState();
    expect(state.element).toBeNull();
    expect(state.itemId).toBe("video-a");
    expect(state.time).toBe(12);
    expect(state.duration).toBe(60);
    expect(state.playing).toBe(true);
  });

  test("re-registering the same item resumes its snapshot", () => {
    startVideoA();
    const second = fakeVideo();
    usePlaybackStore.getState().register(second, {
      itemId: "video-a",
      name: "A.mp4",
    });

    const state = usePlaybackStore.getState();
    expect(state.element).toBe(second);
    expect(state.itemId).toBe("video-a");
    expect(state.time).toBe(12);
    expect(state.playing).toBe(true);
  });

  test("registering a different item starts a fresh snapshot", () => {
    startVideoA();
    const second = fakeVideo();
    usePlaybackStore.getState().register(second, {
      itemId: "video-b",
      name: "B.mp4",
    });

    const state = usePlaybackStore.getState();
    expect(state.element).toBe(second);
    expect(state.itemId).toBe("video-b");
    expect(state.time).toBe(0);
    expect(state.duration).toBe(0);
    expect(state.playing).toBe(false);
  });

  test("stop clears the snapshot so a reopen starts fresh", () => {
    startVideoA();
    usePlaybackStore.getState().stop();

    const state = usePlaybackStore.getState();
    expect(state.element).toBeNull();
    expect(state.itemId).toBeNull();
    expect(state.time).toBe(0);
    expect(state.duration).toBe(0);
    expect(state.playing).toBe(false);
  });
});
