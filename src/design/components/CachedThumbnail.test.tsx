import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CachedThumbnail } from "./CachedThumbnail";

const mocks = vi.hoisted(() => ({
  getThumbnail: vi.fn(),
}));

vi.mock("../../engine/commands/tauri", () => ({
  tauri: { library: { getThumbnail: mocks.getThumbnail } },
  thumbnailToDataUrl: (response: { dataUrl: string }) => response.dataUrl,
}));

vi.mock("../../engine/stores/useSettingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ thumbnailQuality: 78, maxCacheSizeGB: 4 }),
  },
}));

class NoIntersectionObserver {
  observe() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("CachedThumbnail", () => {
  it("loads eagerly even when it is outside the viewport", async () => {
    vi.stubGlobal("IntersectionObserver", NoIntersectionObserver);
    mocks.getThumbnail.mockResolvedValue({
      dataUrl: "data:image/jpeg;base64,dGVzdA==",
    });

    render(<CachedThumbnail itemId="video" name="video.mp4" size={128} eager />);

    await waitFor(() => expect(mocks.getThumbnail).toHaveBeenCalledOnce());
    expect(mocks.getThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "video", size: 128 }),
    );
  });

  it("keeps lazy thumbnails unloaded until they intersect", () => {
    vi.stubGlobal("IntersectionObserver", NoIntersectionObserver);

    render(<CachedThumbnail itemId="photo" name="photo.jpg" size={128} />);

    expect(mocks.getThumbnail).not.toHaveBeenCalled();
  });
});
