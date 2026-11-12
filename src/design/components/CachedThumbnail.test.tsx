import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CachedThumbnail } from "./CachedThumbnail";

const mocks = vi.hoisted(() => ({
  getThumbnail: vi.fn(),
  settings: { thumbnailQuality: 78, maxCacheSizeGB: 4 },
}));

vi.mock("../../engine/commands/tauri", () => ({
  tauri: { library: { getThumbnail: mocks.getThumbnail } },
  thumbnailToDataUrl: (response: { dataUrl: string }) => response.dataUrl,
}));

vi.mock("../../engine/stores/useSettingsStore", () => {
  const useSettingsStore = (selector: (state: typeof mocks.settings) => unknown) =>
    selector(mocks.settings);
  (useSettingsStore as unknown as { getState: () => typeof mocks.settings }).getState = () =>
    mocks.settings;
  return { useSettingsStore };
});

class NoIntersectionObserver {
  observe() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  mocks.settings.thumbnailQuality = 78;
  mocks.settings.maxCacheSizeGB = 4;
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

  it("reuses the shared cache across mounted tiles instead of refetching", async () => {
    vi.stubGlobal("IntersectionObserver", NoIntersectionObserver);
    mocks.getThumbnail.mockResolvedValue({
      dataUrl: "data:image/jpeg;base64,Y2FjaGU=",
    });

    const first = render(<CachedThumbnail itemId="cache-item" name="cache.mp4" size={128} eager />);
    await waitFor(() => expect(mocks.getThumbnail).toHaveBeenCalledOnce());
    first.unmount();

    render(<CachedThumbnail itemId="cache-item" name="cache.mp4" size={128} eager />);
    // Still exactly one call: the second tile is served from the shared cache.
    await waitFor(() => expect(mocks.getThumbnail).toHaveBeenCalledOnce());
  });

  it("requests thumbnails with the current quality after a quality change", async () => {
    vi.stubGlobal("IntersectionObserver", NoIntersectionObserver);
    mocks.getThumbnail.mockResolvedValue({
      dataUrl: "data:image/jpeg;base64,cXVhbGl0eQ==",
    });

    render(<CachedThumbnail itemId="quality-item" name="quality.mp4" size={128} eager />);
    await waitFor(() =>
      expect(mocks.getThumbnail).toHaveBeenCalledWith(expect.objectContaining({ quality: 78 })),
    );

    mocks.settings.thumbnailQuality = 92;
    mocks.getThumbnail.mockClear();
    render(<CachedThumbnail itemId="quality-item-2" name="quality2.mp4" size={128} eager />);
    await waitFor(() =>
      expect(mocks.getThumbnail).toHaveBeenCalledWith(expect.objectContaining({ quality: 92 })),
    );
  });

  it("evicts least-recently-used thumbnails to stay within the byte budget", async () => {
    vi.stubGlobal("IntersectionObserver", NoIntersectionObserver);
    // A quality change clears the shared cache, keeping this test independent.
    mocks.settings.thumbnailQuality = 84;
    mocks.settings.maxCacheSizeGB = 3 / (1024 * 1024 * 1024); // 3 KiB
    mocks.getThumbnail.mockImplementation(async ({ itemId }: { itemId: string }) => ({
      // ~723 UTF-8 bytes per entry, so four entries overflow the 2.7 KiB
      // eviction target and the oldest one must go.
      dataUrl: `data:image/jpeg;base64,${itemId.repeat(700)}`,
    }));

    const { rerender } = render(<CachedThumbnail itemId="a" name="a.jpg" size={128} eager />);
    await waitFor(() => expect(mocks.getThumbnail).toHaveBeenCalledTimes(1));

    let expected = 1;
    for (const id of ["b", "c", "d"]) {
      expected += 1;
      rerender(<CachedThumbnail itemId={id} name={`${id}.jpg`} size={128} eager />);
      await waitFor(() => expect(mocks.getThumbnail).toHaveBeenCalledTimes(expected));
    }

    // "a" was evicted, so asking for it again refetches instead of reusing.
    rerender(<CachedThumbnail itemId="a" name="a.jpg" size={128} eager />);
    await waitFor(() => expect(mocks.getThumbnail).toHaveBeenCalledTimes(5));
    expect(mocks.getThumbnail).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: "a" }));
  });
});
