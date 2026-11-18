import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { makeMediaItem } from "../../test/fixtures";

// The overlay reaches the IPC layer through the store barrel, so only the
// transport is faked: a decodable JPEG slide never calls `invoke`.
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...actual,
    convertFileSrc: (path: string) => `asset://localhost/${path}`,
    invoke: vi.fn(() => Promise.resolve(null)),
  };
});

vi.mock("./CachedThumbnail", () => ({
  CachedThumbnail: () => <span data-testid="thumbnail" />,
}));

import { SlideshowOverlay } from "./SlideshowOverlay";
import { useSlideshowStore } from "../../engine/stores";

beforeEach(() => {
  useSlideshowStore.setState({
    isOpen: true,
    items: [
      makeMediaItem({
        id: "slide-1",
        path: "/tmp/slide-1.jpg",
        name: "slide-1.jpg",
        extension: "jpg",
        kind: "photo",
      }),
    ],
    index: 0,
    playing: false,
  });
});

function renderOverlay() {
  return render(<SlideshowOverlay assetUrl={(path) => path} />);
}

test("tabbing off the last control wraps back to the first", () => {
  renderOverlay();
  const stop = screen.getByRole("button", { name: /stop/i });
  stop.focus();

  fireEvent.keyDown(window, { key: "Tab" });

  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Previous slide" }));
});

test("shift-tabbing from the stage lands on the last control", () => {
  renderOverlay();
  screen.getByRole("dialog").focus();

  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });

  expect(document.activeElement).toBe(screen.getByRole("button", { name: /stop/i }));
});
