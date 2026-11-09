import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import VideoPlayerScreen from "./VideoPlayerScreen";
import { makeMediaItem } from "../test/fixtures";

vi.mock("../design/components/VideoPlayer", () => ({
  default: ({
    itemId,
    active,
    width,
    height,
  }: {
    itemId: string;
    active: boolean;
    width?: number;
    height?: number;
  }) => (
    <div
      data-testid="video-player"
      data-item-id={itemId}
      data-active={active}
      data-width={width}
      data-height={height}
    />
  ),
}));
vi.mock("../design/components/CachedThumbnail", () => ({
  CachedThumbnail: ({ eager }: { eager?: boolean }) => (
    <span data-testid="queue-thumbnail" data-eager={String(!!eager)} />
  ),
}));

const queue = [
  makeMediaItem({
    id: "video-a",
    name: "video-a.mp4",
    kind: "video",
    extension: "mp4",
    width: 1920,
    height: 1080,
  }),
  makeMediaItem({
    id: "video-b",
    name: "video-b.mp4",
    kind: "video",
    extension: "mp4",
    width: 1080,
    height: 1920,
  }),
];

describe("video player screen", () => {
  it("shows a video-only queue and lets the user choose its current item", () => {
    const onSelect = vi.fn();
    render(
      <VideoPlayerScreen
        active
        item={queue[0]}
        queue={queue}
        queueAutoPlayItemId="video-a"
        assetUrl={(path) => path}
        onBack={vi.fn()}
        onSelect={onSelect}
        onPrevious={vi.fn(() => true)}
        onNext={vi.fn(() => true)}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "video-a.mp4" })).toBeInTheDocument();
    expect(screen.getByText("Up next")).toBeInTheDocument();
    expect(screen.getByText("2 videos")).toBeInTheDocument();
    expect(screen.getByTestId("video-player")).toHaveAttribute("data-item-id", "video-a");
    expect(screen.getByTestId("video-player")).toHaveAttribute("data-width", "1920");
    expect(screen.getByTestId("video-player")).toHaveAttribute("data-height", "1080");
    expect(screen.getAllByTestId("queue-thumbnail")[0]).toHaveAttribute("data-eager", "true");
    fireEvent.click(screen.getByRole("button", { name: "Play video-b.mp4" }));
    expect(onSelect).toHaveBeenCalledWith("video-b");
  });

  it("keeps the player mounted but inaccessible while photo browsing is active", () => {
    const { container } = render(
      <VideoPlayerScreen
        active={false}
        item={queue[0]}
        queue={queue}
        queueAutoPlayItemId={null}
        assetUrl={(path) => path}
        onBack={vi.fn()}
        onSelect={vi.fn()}
        onPrevious={vi.fn(() => true)}
        onNext={vi.fn(() => true)}
      />,
    );

    expect(screen.getByTestId("video-player")).toBeInTheDocument();
    expect(container.querySelector("section")).toHaveAttribute("inert");
    expect(container.querySelector("section")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByTestId("queue-thumbnail")[0]).toHaveAttribute("data-eager", "false");
  });
});
