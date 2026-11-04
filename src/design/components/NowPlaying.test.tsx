/// <reference types="vitest/globals" />
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { NowPlaying } from "./NowPlaying";

function renderPill(playing: boolean) {
  const onExpand = vi.fn();
  const onToggle = vi.fn();
  const onStop = vi.fn();
  render(
    <div className="app-frame">
      <NowPlaying
        name="blueprint-399.mov"
        playing={playing}
        onExpand={onExpand}
        onToggle={onToggle}
        onStop={onStop}
      />
    </div>,
  );
  return { onExpand, onToggle, onStop };
}

test("shows the track name and wires play/pause/stop/open controls", () => {
  const { onExpand, onToggle, onStop } = renderPill(true);

  expect(screen.getByText("blueprint-399.mov")).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: /now playing: blueprint-399\.mov\. open player\./i }),
  );
  expect(onExpand).toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(onToggle).toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Stop playback" }));
  expect(onStop).toHaveBeenCalled();
});

test("renders prev/next only when the session is navigable", () => {
  const { unmount } = render(
    <div className="app-frame">
      <NowPlaying
        name="blueprint-399.mov"
        playing
        onExpand={vi.fn()}
        onToggle={vi.fn()}
        onStop={vi.fn()}
      />
    </div>,
  );
  expect(screen.queryByRole("button", { name: "Previous video" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Next video" })).not.toBeInTheDocument();
  unmount();

  const onPrevious = vi.fn();
  const onNext = vi.fn();
  render(
    <div className="app-frame">
      <NowPlaying
        name="blueprint-399.mov"
        playing
        onExpand={vi.fn()}
        onToggle={vi.fn()}
        onStop={vi.fn()}
        onPrevious={onPrevious}
        onNext={onNext}
      />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Previous video" }));
  fireEvent.click(screen.getByRole("button", { name: "Next video" }));
  expect(onPrevious).toHaveBeenCalled();
  expect(onNext).toHaveBeenCalled();
});

test("paused state offers Play instead of Pause", () => {
  renderPill(false);
  expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
});
