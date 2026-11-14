/// <reference types="vitest/globals" />
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  usage: vi.fn(),
  clear: vi.fn(),
  clearMemory: vi.fn(),
}));

vi.mock("../../../engine/commands/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../engine/commands/tauri")>();
  return {
    ...actual,
    tauri: { storage: { usage: mocks.usage, clear: mocks.clear } },
  };
});

vi.mock("../CachedThumbnail", () => ({ clearThumbnailMemoryCache: mocks.clearMemory }));

import { StorageSection } from "./StorageSection";

const usage = {
  catalogBytes: 13 * 1024 * 1024,
  thumbnailBytes: 82 * 1024 * 1024,
  thumbnailFiles: 3766,
  playbackBytes: 0,
  playbackFiles: 0,
  editOriginalBytes: 0,
  editOriginalFiles: 0,
};

describe("StorageSection", () => {
  test("shows each area and clears thumbnails from disk and memory", async () => {
    mocks.usage.mockResolvedValue(usage);
    mocks.clear.mockResolvedValue({
      removedFiles: 3766,
      freedBytes: 82 * 1024 * 1024,
      keptFiles: 0,
    });
    const showNotice = vi.fn();
    render(<StorageSection showNotice={showNotice} />);

    expect(await screen.findByText("82.0 MB · 3,766 files")).toBeInTheDocument();
    expect(screen.getByText("13.0 MB")).toBeInTheDocument();

    const [thumbnails, videos] = screen.getAllByRole("button", { name: "Clear" });
    expect(videos).toBeDisabled();

    fireEvent.click(thumbnails);
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledWith("thumbnails"));
    await waitFor(() => expect(showNotice).toHaveBeenCalledWith("Freed 82.0 MB."));
    expect(mocks.clearMemory).toHaveBeenCalled();
  });

  test("says when videos still in use were kept", async () => {
    mocks.usage.mockResolvedValue({ ...usage, playbackBytes: 2048, playbackFiles: 2 });
    mocks.clear.mockResolvedValue({ removedFiles: 1, freedBytes: 1024, keptFiles: 1 });
    const showNotice = vi.fn();
    render(<StorageSection showNotice={showNotice} />);

    const [, videos] = await screen.findAllByRole("button", { name: "Clear" });
    await waitFor(() => expect(videos).toBeEnabled());
    fireEvent.click(videos);
    await waitFor(() =>
      expect(showNotice).toHaveBeenCalledWith("Freed 1.0 KB. 1 file still in use was kept."),
    );
  });
});
