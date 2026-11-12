import { fireEvent, render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { usePlaybackStore } from "../../engine/stores/usePlaybackStore";
import VideoPlayer from "./VideoPlayer";

// The player never reaches Tauri for a plain in-app MP4, but this test should
// not depend on that: keep the bridge deterministic either way.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn().mockResolvedValue(undefined),
}));

beforeAll(() => {
  // jsdom does not implement media playback; stub the transport controls.
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(),
  });
});

function renderPlayer(props: Partial<React.ComponentProps<typeof VideoPlayer>> = {}) {
  const onPrevious = vi.fn();
  const onNext = vi.fn().mockResolvedValue(true);
  const onToggleFavorite = vi.fn();
  const utils = render(
    <VideoPlayer
      itemId="video-a"
      src="/video-a.mp4"
      path="/video-a.mp4"
      name="video-a.mp4"
      width={1920}
      height={1080}
      onPrevious={onPrevious}
      onNext={onNext}
      onToggleFavorite={onToggleFavorite}
      {...props}
    />,
  );
  return { ...utils, onPrevious, onNext, onToggleFavorite };
}

describe("video player keyboard control", () => {
  it("maps J to previous and K to next", () => {
    const { onPrevious, onNext } = renderPlayer();

    fireEvent.keyDown(window, { key: "j" });
    expect(onPrevious).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { key: "K" });
    expect(onNext).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { key: "J" });
    expect(onPrevious).toHaveBeenCalledTimes(2);
  });

  it("favorites the playing video with L", () => {
    const { onToggleFavorite } = renderPlayer();

    fireEvent.keyDown(window, { key: "l" });
    expect(onToggleFavorite).toHaveBeenCalledOnce();
  });

  it("keeps Space and M for playback and mute", () => {
    const { container } = renderPlayer();

    fireEvent.keyDown(window, { key: "m" });
    const video = container.querySelector("video")!;
    expect(video.muted).toBe(true);

    fireEvent.keyDown(window, { key: "m" });
    expect(video.muted).toBe(false);
  });

  it("ignores shortcuts when focus is inside an editable field", () => {
    const { onPrevious, onNext, onToggleFavorite } = renderPlayer();
    const input = document.createElement("input");
    document.body.appendChild(input);

    fireEvent.keyDown(input, { key: "j" });
    fireEvent.keyDown(input, { key: "k" });
    fireEvent.keyDown(input, { key: "l" });

    expect(onPrevious).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
    expect(onToggleFavorite).not.toHaveBeenCalled();
    input.remove();
  });

  it("keeps a non-zero duration when the next queue item resolves to the same src", () => {
    usePlaybackStore.setState({ itemId: null, name: "", playing: false, time: 0, duration: 0 });

    // Both items point at one file, which is the case the switch used to break:
    // the element never reloads metadata, so nothing reports a duration after
    // the reset.
    const element = (itemId: string) => (
      <VideoPlayer
        itemId={itemId}
        src="/same-clip.mp4"
        path="/same-clip.mp4"
        name={`${itemId}.mp4`}
        width={1920}
        height={1080}
        onPrevious={vi.fn()}
        onNext={vi.fn().mockResolvedValue(true)}
        onToggleFavorite={vi.fn()}
      />
    );

    const { container, rerender } = render(element("video-a"));
    const video = container.querySelector("video")!;
    Object.defineProperty(video, "duration", { configurable: true, value: 4 });
    fireEvent(video, new Event("loadedmetadata"));

    expect(usePlaybackStore.getState().duration).toBe(4);

    rerender(element("video-b"));

    expect(usePlaybackStore.getState().itemId).toBe("video-b");
    // The position is the new item's; the duration belongs to the element.
    expect(usePlaybackStore.getState().time).toBe(0);
    expect(usePlaybackStore.getState().duration).toBe(4);

    const readout = container.querySelectorAll(".video-time");
    expect(readout[readout.length - 1].textContent).toBe("0:04");
  });

  it("does not intercept keys while the background host is inert", () => {
    const { onPrevious, onNext, onToggleFavorite } = renderPlayer({
      active: false,
      compact: true,
    });

    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "l" });

    expect(onPrevious).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
    expect(onToggleFavorite).not.toHaveBeenCalled();
  });
});
