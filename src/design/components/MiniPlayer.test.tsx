import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MiniPlayer } from "./MiniPlayer";

const playbackState = vi.hoisted(() => ({
  itemId: "video-1",
  name: "video.mp4",
  playing: true,
  time: 12,
  duration: 60,
  muted: false,
  element: null as HTMLVideoElement | null,
  toggle: vi.fn(),
  seek: vi.fn(),
  toggleMute: vi.fn(),
}));

vi.mock("../../engine/stores/usePlaybackStore", () => ({
  usePlaybackStore: <T,>(selector: (state: typeof playbackState) => T): T =>
    selector(playbackState),
}));

type WebKitVideo = HTMLVideoElement & {
  webkitPresentationMode?: "inline" | "picture-in-picture";
  webkitSetPresentationMode?: (mode: "inline" | "picture-in-picture") => void;
  webkitSupportsPresentationMode?: (mode: "inline" | "picture-in-picture") => boolean;
};

describe("Now Playing picture in picture control", () => {
  it("can float the video while the photo viewer is open", async () => {
    const video = document.createElement("video") as WebKitVideo;
    video.webkitPresentationMode = "inline";
    video.webkitSupportsPresentationMode = vi.fn(() => true);
    video.webkitSetPresentationMode = vi.fn((mode) => {
      video.webkitPresentationMode = mode;
      video.dispatchEvent(new Event("webkitpresentationmodechanged"));
    });
    playbackState.element = video;

    render(
      <MiniPlayer
        onExpand={vi.fn()}
        onClose={vi.fn()}
        onPrevious={vi.fn(() => true)}
        onNext={vi.fn(() => true)}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Enter picture in picture",
    });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Exit picture in picture" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(video.webkitSetPresentationMode).toHaveBeenCalledWith("picture-in-picture");
  });
});
